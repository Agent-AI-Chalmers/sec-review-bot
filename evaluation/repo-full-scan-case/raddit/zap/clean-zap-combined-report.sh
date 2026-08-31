#!/usr/bin/env bash
set -euo pipefail

FRONTEND_REPORT="${1:-zap-frontend-report.json}"
API_REPORT="${2:-zap-api-report.json}"
OUTPUT_FILE="${3:-zap-combined-clean.json}"

if [ ! -f "$FRONTEND_REPORT" ]; then
  echo "Frontend report not found: $FRONTEND_REPORT" >&2
  exit 1
fi

if [ ! -f "$API_REPORT" ]; then
  echo "API report not found: $API_REPORT" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required but not installed." >&2
  exit 1
fi

jq -n \
  --slurpfile frontend "$FRONTEND_REPORT" \
  --slurpfile api "$API_REPORT" \
  --arg frontend_report "$FRONTEND_REPORT" \
  --arg api_report "$API_REPORT" '
def clean_html:
  gsub("</p><p>"; " ")
  | gsub("<p>"; "")
  | gsub("</p>"; "")
  | gsub("<[^>]+>"; "")
  | gsub("&quot;"; "\"")
  | gsub("&amp;"; "&")
  | gsub("\uFFFD"; "")
  | gsub("\\s+"; " ")
  | gsub("^\\s+|\\s+$"; "");

def clean_text:
  (. // "")
  | tostring
  | gsub("\uFFFD"; "")
  | gsub("\\s+"; " ")
  | gsub("^\\s+|\\s+$"; "");

def risk:
  .riskdesc | split(" ")[0];

def risk_rank:
  if risk == "High" then 3
  elif risk == "Medium" then 2
  elif risk == "Low" then 1
  else 0
  end;

def normalize_alert($source):
  {
    source: $source,
    pluginid,
    alert,
    risk: risk,
    riskdesc,
    risk_rank: risk_rank,
    confidence: (.confidence | tonumber? // .confidence),
    instance_count: (.instances | length),
    urls: ([.instances[].uri] | unique),
    params: ([.instances[].param | select(. != null and . != "") | clean_text] | unique),
    attacks: ([.instances[].attack | select(. != null and . != "") | clean_text] | unique),
    evidence: ([.instances[].evidence | select(. != null and . != "") | clean_text] | unique),
    description: ((.desc // "") | clean_html),
    solution: ((.solution // "") | clean_html)
  };

def alerts($doc; $source):
  $doc.site[]
  | .alerts[]
  | normalize_alert($source);

def keep_frontend:
  .source == "frontend"
  and (
    (.pluginid == "10038" and .alert == "Content Security Policy (CSP) Header Not Set")
    or (.pluginid == "10020" and .alert == "Missing Anti-clickjacking Header")
    or (.pluginid == "90022" and .alert == "Application Error Disclosure")
    or (.pluginid == "90004" and .alert == "Cross-Origin-Embedder-Policy Header Missing or Invalid")
    or (.pluginid == "90004" and .alert == "Cross-Origin-Opener-Policy Header Missing or Invalid")
    or (.pluginid == "90004" and .alert == "Cross-Origin-Resource-Policy Header Missing or Invalid")
    or (.pluginid == "10063" and .alert == "Permissions Policy Header Not Set")
    or (.pluginid == "10021" and .alert == "X-Content-Type-Options Header Missing")
  );

def keep_api:
  .source == "api"
  and (
    (.pluginid == "10097" and .alert == "Hash Disclosure - BCrypt")
    or (.pluginid == "90020" and .alert == "Remote OS Command Injection")
    or (.pluginid == "40018" and .alert == "SQL Injection")
    or (.pluginid == "30002" and .alert == "Format String Error")
    or (.pluginid == "100000" and .alert == "A Server Error response code was returned by the server")
    or (.pluginid == "10054" and .alert == "Cookie without SameSite Attribute")
    or (.pluginid == "90004" and .alert == "Cross-Origin-Resource-Policy Header Missing or Invalid")
    or (.pluginid == "10021" and .alert == "X-Content-Type-Options Header Missing")
  );

[
  alerts($frontend[0]; "frontend"),
  alerts($api[0]; "api")
]
| flatten as $raw_alerts
| ($raw_alerts | map(select(keep_frontend or keep_api)) | sort_by(-.risk_rank, .source, .pluginid, .alert)) as $clean_alerts
| {
    reports: {
      frontend: $frontend_report,
      api: $api_report
    },
    summary: {
      raw_alert_groups: ($raw_alerts | length),
      raw_alert_instances: ($raw_alerts | map(.instance_count) | add),
      clean_alert_groups: ($clean_alerts | length),
      clean_alert_instances: ($clean_alerts | map(.instance_count) | add)
    },
    alerts: $clean_alerts
  }
' > "$OUTPUT_FILE"

echo "Clean combined ZAP report written to: $OUTPUT_FILE"
jq '.summary' "$OUTPUT_FILE"
