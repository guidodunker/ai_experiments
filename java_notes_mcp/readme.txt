Der MCP-Service liegt in java_notes_mcp/ und läuft. Er basiert auf Spring Boot 4.1.2 mit Spring AI 2.0.2 und spricht Streamable HTTP. Drei Integrationstests verbinden sich als echter MCP-Client mit dem Server und laufen grün (mvn test).

Tools
- addNote(text) speichert eine Notiz und gibt ihre Nummer zurück. Die Nummern beginnen bei 1 und zählen fortlaufend hoch.
- getNote(number) liefert die Notiz zu einer Nummer. Gibt es die Nummer nicht, kommt ein Fehler mit der aktuellen Anzahl der Notizen.

Dateien
- NoteTools.java enthält die beiden MCP-Tools.
- NoteStore.java hält die Notizen und vergibt die Nummern. Es ist threadsicher.
- application.properties setzt Port 8001 (dein Python-Server nutzt 8000) und den Endpoint /mcp.
- NotesMcpServerTest.java enthält die Tests: beide Tools werden angeboten, die Nummern steigen fortlaufend, die Notizen lassen sich über ihre Nummer finden, eine unbekannte Nummer liefert einen Fehler.

Starten
cd java_notes_mcp
mvn spring-boot:run
Danach erreichst du den Server unter http://localhost:8001/mcp. In Claude Code bindest du ihn so ein:
claude mcp add --transport http notes-java http://localhost:8001/mcp