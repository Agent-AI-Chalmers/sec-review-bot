#!/usr/bin/env bash
set -euo pipefail

FRONTEND_FILE="${1:-zap-frontend-report.json}"
API_FILE="${2:-zap-api-report.json}"
OUTPUT_FILE="${3:-zap-report-clean.json}"
FRONTEND_TARGET="${4:-http://localhost:3001}"
API_TARGET="${5:-http://localhost:5000}"

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
  --arg frontend_target "$FRONTEND_TARGET" \
  --arg api_target "$API_TARGET" \
  --arg frontend_file "$FRONTEND_FILE" \
  --arg api_file "$API_FILE" '
def ignored_pluginids:
  [
    "90005",
    "10109",
    "10049"
  ];

def ignored_url:
  contains("/@vite/client")
  or contains("/@react-refresh")
  or contains("/@id/")
  or contains("/@fs/")
  or contains("/__vite")
  or contains("/node_modules/")
  or contains("/src/")
  or contains("/favicon.ico")
  or contains("/vite.svg")
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

def is_info:
  (
    .pluginid == "10027" and .alert == "Information Disclosure - Suspicious Comments"
  )
  or (
    .pluginid == "10111" and .alert == "Authentication Request Identified"
  )
  or (
    .pluginid == "100000" and .alert == "A Client Error response code was returned by the server"
  )
  or (
    .pluginid == "10024" and .alert == "Information Disclosure - Sensitive Information in URL"
  );

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
  target: {
    frontend: $frontend_target,
    api: $api_target
  },
  generated: {
    frontend: $frontend[0].created,
    api: $api[0].created
  },
  filtering: {
    mode: "worldpress-combined-filter",
    raw_reports: [$frontend_file, $api_file],
    note: "The raw reports are preserved. This clean report removes only known Vite frontend noise and scanner-request noise; all other frontend and backend alerts are preserved for manual triage.",
    ignored_pluginids: ignored_pluginids,
    ignored_paths: [
      "/@vite/client",
      "/@react-refresh",
      "/@id/",
      "/@fs/",
      "/__vite",
      "/node_modules/",
      "/src/",
      "/favicon.ico",
      "/vite.svg",
      "/robots.txt",
      "/sitemap.xml"
    ]
  },
  alerts: (
    [
      extract_alerts($frontend[0]; $frontend_target),
      extract_alerts($api[0]; $api_target)
    ]
    | add
    | map(select(is_info | not))
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
