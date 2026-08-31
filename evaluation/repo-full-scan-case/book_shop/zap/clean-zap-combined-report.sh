#!/usr/bin/env bash
set -euo pipefail

FRONTEND_FILE="${1:-zap-report.json}"
API_FILE="${2:-zap-api-report.json}"
OUTPUT_FILE="${3:-zap-combined-clean.json}"
TARGET="${4:-http://localhost:3001}"

if [ ! -f "$FRONTEND_FILE" ]; then
  echo "Input file not found: $FRONTEND_FILE" >&2
  exit 1
fi

if [ ! -f "$API_FILE" ]; then
  echo "Input file not found: $API_FILE" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required but not installed." >&2
  exit 1
fi

jq -n \
  --slurpfile frontend "$FRONTEND_FILE" \
  --slurpfile api "$API_FILE" \
  --arg target "$TARGET" \
  --arg frontend_file "$FRONTEND_FILE" \
  --arg api_file "$API_FILE" '
def ignored_pluginids:
  [
    "110005",
    "10110",
    "110009",
    "10096",
    "10094",
    "10027",
    "90005",
    "10049"
  ];

def ignored_url:
  contains("/_next/static/")
  or contains("/_next/webpack-hmr")
  or contains("/favicon.ico")
  or contains("/robots.txt")
  or contains("/sitemap.xml");

def normalize_url:
  sub("/$"; "");

def risk_name:
  .riskdesc | split(" ")[0];

def risk_rank:
  if risk_name == "High" then 3
  elif risk_name == "Medium" then 2
  elif risk_name == "Low" then 1
  else 0
  end;

def clean_html:
  (. // "")
  | gsub("</p><p>"; " ")
  | gsub("<p>"; "")
  | gsub("</p>"; "")
  | gsub("<br\\s*/?>"; " ")
  | gsub("<[^>]+>"; "")
  | gsub("&quot;"; "\"")
  | gsub("&amp;"; "&")
  | gsub("&lt;"; "<")
  | gsub("&gt;"; ">")
  | gsub("\\s+"; " ")
  | gsub("^\\s+|\\s+$"; "");

def clean_text:
  (. // "")
  | tostring
  | gsub("\uFFFD"; "")
  | gsub("\\s+"; " ")
  | gsub("^\\s+|\\s+$"; "");

def extract_alerts($report; $target):
  [
    $report.site[]
    | select(."@name" == $target)
    | .alerts[]
    | select((.pluginid as $id | ignored_pluginids | index($id)) | not)
    | {
        id: (.pluginid + ":" + .alert),
        pluginid,
        alert,
        alertRef,
        risk: risk_name,
        risk_rank: risk_rank,
        riskcode: (.riskcode | tonumber? // .riskcode),
        riskdesc,
        confidence: (.confidence | tonumber? // .confidence),
        cweid,
        wascid,
        urls: (
          [
            (.instances // [])[].uri
            | select(ignored_url | not)
            | normalize_url
          ]
          | unique
        ),
        instances: (
          [
            (.instances // [])[]
            | select(.uri | ignored_url | not)
            | {
                uri: (.uri | normalize_url),
                method,
                param,
                evidence: (.evidence | clean_text),
                otherinfo: (.otherinfo | clean_text)
              }
          ]
          | unique_by(.uri, .method, .param, .evidence, .otherinfo)
        ),
        solution: (.solution | clean_html),
        reference: (.reference | clean_html)
      }
    | .count = (.urls | length)
    | select(.count > 0)
  ];

def merge_alerts:
  sort_by(.id)
  | group_by(.id)
  | map({
      id: .[0].id,
      pluginid: .[0].pluginid,
      alert: .[0].alert,
      alertRef: .[0].alertRef,
      risk: .[0].risk,
      risk_rank: .[0].risk_rank,
      riskcode: .[0].riskcode,
      riskdesc: .[0].riskdesc,
      confidence: .[0].confidence,
      cweid: .[0].cweid,
      wascid: .[0].wascid,
      urls: ([.[].urls[]] | unique),
      instances: ([.[].instances[]] | unique_by(.uri, .method, .param, .evidence, .otherinfo)),
      solution: .[0].solution,
      reference: .[0].reference
    } | .count = (.urls | length));

{
  target: $target,
  generated: {
    frontend: $frontend[0].created,
    api: $api[0].created
  },
  filtering: {
    mode: "book-shop-combined-filter",
    raw_reports: [$frontend_file, $api_file],
    note: "The raw reports are preserved. This clean report removes only known Next.js dev-server noise and scanner-request noise; all other frontend and API alerts are preserved for manual triage.",
    ignored_pluginids: ignored_pluginids,
    ignored_paths: [
      "/_next/static/",
      "/_next/webpack-hmr",
      "/favicon.ico",
      "/robots.txt",
      "/sitemap.xml"
    ]
  },
  alerts: (
    [
      extract_alerts($frontend[0]; $target),
      extract_alerts($api[0]; $target)
    ]
    | add
    | merge_alerts
    | sort_by(-.risk_rank, .pluginid, .alert)
  )
}
| .summary = {
    total_alerts: (.alerts | length),
    high: ([.alerts[] | select(.risk == "High")] | length),
    medium: ([.alerts[] | select(.risk == "Medium")] | length),
    low: ([.alerts[] | select(.risk == "Low")] | length),
    info: ([.alerts[] | select(.risk == "Informational")] | length),
    affected_urls: ([.alerts[].urls[]] | unique | length)
  }
' > "$OUTPUT_FILE"

echo "Clean ZAP report written to: $OUTPUT_FILE"
jq '.summary' "$OUTPUT_FILE"
