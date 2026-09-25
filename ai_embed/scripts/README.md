# Embedding-Skripte

Zwei Skripte für die zwei Zeitpunkte, an denen Embeddings berechnet werden.

| | wann | wie oft | Latenz |
|---|---|---|---|
| `index-corpus.ts` | Dokument kommt rein oder ändert sich | einmal pro (Dokument, Modell) | egal |
| `query.ts` | bei jeder Suchanfrage | einmal pro Suche | auf dem kritischen Pfad |

## Aufruf

**Unter PowerShell nicht `npm run ... -- --flag` verwenden** — `npm.ps1` schluckt
das `--`, die Argumente kommen nie im Skript an, und der Lauf startet still mit
den Standardwerten. Entweder `npm.cmd` nehmen oder direkt `node`:

```powershell
# ohne Argumente: npm ist in Ordnung
npm run embed:index

# mit Argumenten: npm.cmd oder node
npm.cmd run embed:query -- "womit säge ich Kurven in Holz"
node --experimental-strip-types --env-file=.env scripts/query.ts "womit säge ich Kurven in Holz" --k=5
```

## Ein Modell, nicht viele

`EMBEDDING_MODEL` in `.env` legt das Modell fest — für Indexierung **und**
Suche. Das ist bewusst eine gemeinsame Einstellung: ein Korpus, der mit Modell A
eingebettet wurde, ist mit einer Anfrage aus Modell B nicht durchsuchbar, auch
nicht bei gleicher Dimension.

```
EMBEDDING_MODEL=qwen3-8b
```

Bekannte Aliase stehen in `lib/models.ts`. `--model=<alias|openrouter-id>`
übersteuert für einen Aufruf, `--all` nimmt die ganze Registry — beides ist der
ausdrückliche Weg in einen Mehrmodell-Vergleich.

## index-corpus.ts

```powershell
node --experimental-strip-types --env-file=.env scripts/index-corpus.ts [Optionen]
```

| Option | Wirkung |
|---|---|
| `--model=a,b` | statt `EMBEDDING_MODEL` |
| `--all` | alle Modelle der Registry |
| `--force` | auch schon vorhandene Vektoren neu berechnen |
| `--batch=N` | Texte pro API-Request, Standard 16 |
| `--limit=N` | nur die ersten N offenen Dokumente |

Ohne `--force` werden nur Dokumente angefasst, für die mit diesem Modell noch
kein Vektor existiert. Der Lauf ist damit wiederholbar und nimmt nach einem
Abbruch die Arbeit wieder auf.

Ob das Modell mehrere Texte pro Request akzeptiert, wird nicht angenommen,
sondern beim ersten Batch ausprobiert; scheitert es, fällt dieses Modell auf
Einzelrequests zurück. Bei 429/5xx wird mit wachsender Wartezeit wiederholt.

## query.ts

```powershell
node --experimental-strip-types --env-file=.env scripts/query.ts "<Suchanfrage>" [--k=5] [--model=…]
```

Gibt pro Modell die Top-k aus und trennt dabei **Embedding-Dauer von DB-Dauer**.
Bei mehreren Modellen kommt eine Übereinstimmungsmatrix dazu: Anteil gemeinsamer
Treffer in den Top-k. Niedrige Werte heißen nicht, dass ein Modell falsch liegt
— sie zeigen, wo du selbst entscheiden musst, welche Liste besser ist.

## Präfixe

Manche Modelle behandeln Anfrage und Dokument unterschiedlich. Das steht in
`lib/models.ts` pro Modell und ist keine Feinheit: falsch gesetzt misst ein
Vergleich das Präfix statt das Modell.

| Modell | Anfrage | Dokument |
|---|---|---|
| `qwen3-8b`, `qwen3-4b` | `Instruct: <Aufgabe>\nQuery: …` | ohne |
| `e5-multi` | `query: …` | `passage: …` |
| `bge-en` | `Represent this sentence…: …` | ohne |
| `bge-m3`, OpenAI, Gemini, Voyage | ohne | ohne |

Die Aufgabenbeschreibung für Qwen steht als `TASK` in `lib/models.ts` und ist
domänenspezifisch formuliert. Eine generische Beschreibung kostet Trefferqualität.

Voyage (`input_type`) und Gemini (`task_type`) haben eigene Parameter für diese
Unterscheidung. Über die OpenAI-kompatible Route von OpenRouter sind die nicht
setzbar — diese Modelle laufen hier also unterhalb ihrer Möglichkeiten.

## Absolute Distanzen sind nicht vergleichbar

Nur Ranglisten sind zwischen Modellen vergleichbar, nicht die Zahlenwerte.
`e5-multi` liefert für dieselbe Anfrage Distanzen um 0,16, `oai-3-large` um 0,55
— das sagt nichts darüber aus, welches Modell besser trifft.
