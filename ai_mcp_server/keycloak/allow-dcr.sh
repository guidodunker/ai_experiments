#!/bin/bash
# Lets MCP clients such as Claude Code register themselves (RFC 7591 dynamic
# client registration) in realm "mcp". Keycloak's default "Trusted Hosts"
# policy rejects such requests, so we relax it: the request may come from any
# host, but the client's redirect URIs must point to localhost.
#
# Run once after the database is created (first `docker compose up`, or after `down -v`):
#   docker compose exec -T keycloak bash < allow-dcr.sh
set -euo pipefail
kcadm=/opt/keycloak/bin/kcadm.sh

$kcadm config credentials --server http://localhost:8080 --realm master --user admin --password admin

id=$($kcadm get components -r mcp -q name="Trusted Hosts" --fields id --format csv --noquotes)
$kcadm update "components/$id" -r mcp \
  -s 'config."host-sending-registration-request-must-match"=["false"]' \
  -s 'config."client-uris-must-match"=["true"]' \
  -s 'config."trusted-hosts"=["localhost","127.0.0.1"]'
echo "Trusted Hosts policy updated ($id)"
