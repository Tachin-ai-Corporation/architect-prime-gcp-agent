set -x
set -euo pipefail
HTTP_CODE=200
echo '{"files":[]}' > /tmp/drive-search.json
if [[ "$HTTP_CODE" == "200" ]]; then
  EXISTING_ID=$(jq -r '.files[0].id // empty' /tmp/drive-search.json 2>/dev/null || true)
  if [[ -n "$EXISTING_ID" ]]; then
    echo "EXISTING"
  fi
fi
echo "SUCCESS"
