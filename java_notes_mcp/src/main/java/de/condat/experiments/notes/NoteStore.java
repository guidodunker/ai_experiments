package de.condat.experiments.notes;

import java.util.Map;
import java.util.Optional;
import java.util.SortedMap;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

import org.springframework.stereotype.Component;

/**
 * Keeps notes in memory and numbers them consecutively, starting at 1.
 * Notes live only as long as the server process.
 */
@Component
public class NoteStore {

    private final Map<Integer, String> notes = new ConcurrentHashMap<>();
    private final AtomicInteger lastNumber = new AtomicInteger();

    public int add(String text) {
        int number = lastNumber.incrementAndGet();
        notes.put(number, text);
        return number;
    }

    public Optional<String> find(int number) {
        return Optional.ofNullable(notes.get(number));
    }

    public SortedMap<Integer, String> all() {
        return new TreeMap<>(notes);
    }

    public int count() {
        return notes.size();
    }
}
