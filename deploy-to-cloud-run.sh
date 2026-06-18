#!/usr/bin/env bash
# Deploy FIELD to Cloud Run. Mirrors the symione-core deploy pattern.
# Usage: MOLLIE_API_KEY=test_xxx ./deploy-to-cloud-run.sh
set -euo pipefail

PROJECT_ID="${GOOGLE_CLOUD_PROJECT:-symionemarket-prod}"
SERVICE_NAME="${SERVICE_NAME:-field-backend}"
REGION="${REGION:-europe-west1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v gcloud >/dev/null 2>&1 || { echo "[FAIL] gcloud not installed. Run: gcloud auth login"; exit 1; }
: "${MOLLIE_API_KEY:?[FAIL] export MOLLIE_API_KEY=test_... before deploying}"

echo "[DEPLOY] $SERVICE_NAME -> project=$PROJECT_ID region=$REGION"
gcloud run deploy "$SERVICE_NAME" \
  --source "$SCRIPT_DIR" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --allow-unauthenticated \
  --port 8080 \
  --set-env-vars "MOLLIE_API_KEY=$MOLLIE_API_KEY,DB_PATH=/tmp/field.db"

SERVICE_URL="$(gcloud run services describe "$SERVICE_NAME" --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')"
echo "[OK] Deployed: $SERVICE_URL"

# BASE_URL must point at the live service so QR/redirect/webhook URLs resolve.
gcloud run services update "$SERVICE_NAME" --project "$PROJECT_ID" --region "$REGION" \
  --update-env-vars "BASE_URL=$SERVICE_URL" >/dev/null
echo "[OK] BASE_URL set to $SERVICE_URL"

echo "[CHECK] /health"
for i in 1 2 3 4 5 6; do
  if curl -fsS "$SERVICE_URL/health" >/dev/null 2>&1; then echo "[OK] healthy"; break; fi
  sleep 5
done
echo "[SUCCESS] $SERVICE_URL"
echo "NOTE: SQLite on Cloud Run is ephemeral. Run the seed once via the live API, demo, done."
