package de.condat.experiments.notes;

import java.util.stream.Collectors;

import org.springframework.ai.mcp.annotation.McpTool;
import org.springframework.ai.mcp.annotation.McpToolParam;
import org.springframework.stereotype.Component;

@Component
public class NoteTools {

    private final NoteStore store;

    public NoteTools(NoteStore store) {
        this.store = store;
    }

    @McpTool(name = "addNote", description = "Save a note and return its number.")
    public int addNote(@McpToolParam(description = "Text of the note") String text) {
        return store.add(text);
    }

    @McpTool(name = "getNote", description = "Return the note with the given number.")
    public String getNote(@McpToolParam(description = "Number of the note, starting at 1") int number) {
        return store.find(number).orElseThrow(() -> new IllegalArgumentException(
                "No note with number " + number + ". There are " + store.count() + " notes."));
    }

    @McpTool(name = "listNotes", description = "Return all notes, one per line, as '<number>. <text>'.")
    public String listNotes() {
        var notes = store.all();
        if (notes.isEmpty()) {
            return "There are no notes.";
        }
        return notes.entrySet().stream()
                .map(e -> e.getKey() + ". " + e.getValue())
                .collect(Collectors.joining("\n"));
    }
}
