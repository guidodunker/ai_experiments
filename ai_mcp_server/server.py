"""Simple MCP server that stores notes in memory, protected by OAuth 2.1.

The server is an OAuth resource server: Keycloak (see keycloak/) issues the
tokens, this server only validates them.
"""

import asyncio

import jwt
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.provider import AccessToken
from mcp.server.auth.settings import AuthSettings
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError

ISSUER = "http://localhost:8180/realms/mcp"
RESOURCE = "http://127.0.0.1:8000/mcp"


class KeycloakTokenVerifier:
    """Validates Keycloak access tokens (JWTs) against the realm's signing keys."""

    def __init__(self) -> None:
        self._jwks = jwt.PyJWKClient(f"{ISSUER}/protocol/openid-connect/certs")

    async def verify_token(self, token: str) -> AccessToken | None:
        try:
            # PyJWKClient fetches the keys with blocking I/O, so keep it off the event loop.
            key = await asyncio.to_thread(self._jwks.get_signing_key_from_jwt, token)
            claims = jwt.decode(
                token,
                key.key,
                algorithms=["RS256"],
                issuer=ISSUER,
                # Rejects tokens Keycloak issued for other services.
                audience=RESOURCE,
                options={"require": ["exp", "iss", "aud", "sub"]},
            )
        except jwt.PyJWTError:
            return None
        return AccessToken(
            token=token,
            client_id=claims.get("azp", ""),
            scopes=claims.get("scope", "").split(),
            expires_at=claims["exp"],
            resource=RESOURCE,
            subject=claims["sub"],
            claims=claims,
        )


def require_scope(scope: str) -> None:
    token = get_access_token()
    if token is None or scope not in token.scopes:
        raise ToolError(f"Missing scope {scope}.")


mcp = MCPServer(
    "notes",
    token_verifier=KeycloakTokenVerifier(),
    auth=AuthSettings(
        issuer_url=ISSUER,
        resource_server_url=RESOURCE,
        # Also advertised to clients, which request exactly these scopes at login.
        required_scopes=["notes:read", "notes:write"],
        validate_token_resource=True,
    ),
)

# Notes live only for the lifetime of the server process.
notes: list[str] = []


@mcp.tool()
def addNote(text: str) -> int:
    """Save a note and return its id."""
    require_scope("notes:write")
    notes.append(text)
    return len(notes) - 1


@mcp.tool()
def getNote(id: int) -> str:
    """Return the note with the given id."""
    require_scope("notes:read")
    if id < 0 or id >= len(notes):
        raise ToolError(f"No note with id {id}. There are {len(notes)} notes.")
    return notes[id]


if __name__ == "__main__":
    mcp.run(transport="streamable-http", host="127.0.0.1", port=8000)
