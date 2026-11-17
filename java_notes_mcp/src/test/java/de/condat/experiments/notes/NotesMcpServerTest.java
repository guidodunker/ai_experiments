package de.condat.experiments.notes;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;

import io.modelcontextprotocol.client.McpClient;
import io.modelcontextprotocol.client.McpSyncClient;
import io.modelcontextprotocol.client.transport.HttpClientStreamableHttpTransport;
import io.modelcontextprotocol.spec.McpSchema.CallToolRequest;
import io.modelcontextprotocol.spec.McpSchema.CallToolResult;
import io.modelcontextprotocol.spec.McpSchema.TextContent;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class NotesMcpServerTest {

    @LocalServerPort
    int port;

    McpSyncClient client;

    @BeforeEach
    void connect() {
        var transport = HttpClientStreamableHttpTransport.builder("http://localhost:" + port)
                .endpoint("/mcp")
                .build();
        client = McpClient.sync(transport).build();
        client.initialize();
    }

    @AfterEach
    void close() {
        client.closeGracefully();
    }

    @Test
    void listsBothTools() {
        var names = client.listTools().tools().stream().map(t -> t.name()).toList();
        assertThat(names).contains("addNote", "getNote");
    }

    @Test
    void numbersNotesConsecutivelyAndFindsThemByNumber() {
        int first = Integer.parseInt(text(call("addNote", Map.of("text", "Milch kaufen"))));
        int second = Integer.parseInt(text(call("addNote", Map.of("text", "Zahnarzt anrufen"))));

        assertThat(second).isEqualTo(first + 1);
        assertThat(text(call("getNote", Map.of("number", first)))).contains("Milch kaufen");
        assertThat(text(call("getNote", Map.of("number", second)))).contains("Zahnarzt anrufen");
    }

    @Test
    void unknownNumberIsAnError() {
        CallToolResult result = call("getNote", Map.of("number", 9999));

        assertThat(result.isError()).isTrue();
        assertThat(text(result)).contains("No note with number 9999");
    }

    private CallToolResult call(String tool, Map<String, Object> args) {
        return client.callTool(new CallToolRequest(tool, args));
    }

    private static String text(CallToolResult result) {
        return ((TextContent) result.content().get(0)).text();
    }
}
