-- ---------------------------------------------------------------------------
-- 100 Baumarkt-Produkte als Testkorpus.
--
-- Wird NICHT automatisch ausgeführt (db/init läuft nur bei leerem Volume).
-- Einspielen (Windows/PowerShell — nicht über eine Pipe, sonst leiden Umlaute):
--   docker cp db/seed/01_baumarkt_products.sql ai_embed_pgvector:/tmp/seed.sql
--   docker exec ai_embed_pgvector psql -U embed -d embed -v ON_ERROR_STOP=1 -f /tmp/seed.sql
--
-- Die strukturierten Felder liegen in documents.meta (jsonb), der einzubettende
-- Text wird daraus per render_product() erzeugt. Die Textvorlage ist beim
-- Modellvergleich selbst eine Variable — ändere die Funktion und rendere neu:
--   UPDATE documents SET content = render_product(meta) WHERE meta ? 'name';
--
-- Umlaute sind bewusst echt (ä/ö/ü/ß), nicht transliteriert: Tokenizer
-- behandeln "Stichsäge" und "Stichsaege" unterschiedlich, und genau das soll
-- der Test messen — nicht ein Encoding-Artefakt.
--
-- Das Skript ist wiederholbar (ON CONFLICT auf external_id).
-- ---------------------------------------------------------------------------

BEGIN;

CREATE OR REPLACE FUNCTION render_product(p jsonb) RETURNS text
LANGUAGE sql IMMUTABLE AS $fn$
    SELECT format(
        '%s. Kategorie: %s, %s. Marke: %s. Einsatzgebiete: %s. Merkmale: %s. Preissegment: %s.',
        p ->> 'name',
        p ->> 'category',
        p ->> 'subCategory',
        p ->> 'brand',
        (SELECT string_agg(v, ', ' ORDER BY o)
         FROM jsonb_array_elements_text(p -> 'useCases') WITH ORDINALITY t(v, o)),
        (SELECT string_agg(v, ', ' ORDER BY o)
         FROM jsonb_array_elements_text(p -> 'features') WITH ORDINALITY t(v, o)),
        p ->> 'priceSegment');
$fn$;

COMMENT ON FUNCTION render_product(jsonb) IS
    'Rendert ein Produkt-meta zu dem Text, der eingebettet wird. Bewusst austauschbar.';


WITH raw (external_id, meta) AS (
    VALUES
    -- === Elektrowerkzeuge: Sägen ============================================
    ('prod-001', '{"name":"Bosch Stichsäge PST 900 PEL","category":"Elektrowerkzeuge","subCategory":"Sägen","brand":"Bosch","priceSegment":"mittel","useCases":["Holz schneiden","Kurvenschnitte","Heimwerken"],"features":["Pendelhub","CutControl","620 W","werkzeugloser Sägeblattwechsel"]}'),
    ('prod-002', '{"name":"Makita Stichsäge 4351FCTJ","category":"Elektrowerkzeuge","subCategory":"Sägen","brand":"Makita","priceSegment":"premium","useCases":["Präzise Kurvenschnitte","Laminat schneiden","Profieinsatz"],"features":["Pendelhub","720 W","LED-Arbeitslicht","Makpac-Koffer"]}'),
    ('prod-003', '{"name":"Einhell Akku-Stichsäge TE-JS 18 Li","category":"Elektrowerkzeuge","subCategory":"Sägen","brand":"Einhell","priceSegment":"günstig","useCases":["Holz schneiden","Gelegentliches Heimwerken","Kabelloses Arbeiten"],"features":["18 V Power X-Change","Pendelhub","ohne Akku und Ladegerät"]}'),
    ('prod-004', '{"name":"Makita Handkreissäge HS7601J","category":"Elektrowerkzeuge","subCategory":"Sägen","brand":"Makita","priceSegment":"mittel","useCases":["Bretter ablängen","Plattenzuschnitt","Dachlatten sägen"],"features":["190 mm Sägeblatt","1200 W","66 mm Schnitttiefe"]}'),
    ('prod-005', '{"name":"DeWalt Tauchsäge DWS520KR","category":"Elektrowerkzeuge","subCategory":"Sägen","brand":"DeWalt","priceSegment":"premium","useCases":["Plattenzuschnitt","Möbelbau","Splitterfreie Schnitte"],"features":["1300 W","Führungsschiene","59 mm Schnitttiefe","Tauchfunktion"]}'),
    ('prod-006', '{"name":"Einhell Akku-Säbelsäge TE-AP 18 Li","category":"Elektrowerkzeuge","subCategory":"Sägen","brand":"Einhell","priceSegment":"günstig","useCases":["Äste absägen","Abbrucharbeiten","Paletten zerlegen"],"features":["18 V Power X-Change","werkzeugloser Sägeblattwechsel","Pendelhub"]}'),

    -- === Elektrowerkzeuge: Bohren und Schrauben =============================
    ('prod-007', '{"name":"Bosch Professional Akku-Bohrschrauber GSR 18V-55","category":"Elektrowerkzeuge","subCategory":"Bohren und Schrauben","brand":"Bosch","priceSegment":"mittel","useCases":["Schrauben eindrehen","Löcher bohren","Möbelmontage"],"features":["18 V","bürstenloser Motor","2-Gang-Getriebe","55 Nm"]}'),
    ('prod-008', '{"name":"Makita Akku-Schlagbohrschrauber DHP484Z","category":"Elektrowerkzeuge","subCategory":"Bohren und Schrauben","brand":"Makita","priceSegment":"premium","useCases":["Bohren in Mauerwerk","Schrauben eindrehen","Profieinsatz"],"features":["18 V LXT","bürstenlos","54 Nm","Schlagbohrfunktion"]}'),
    ('prod-009', '{"name":"Einhell Akku-Bohrschrauber TE-CD 18/40 Li","category":"Elektrowerkzeuge","subCategory":"Bohren und Schrauben","brand":"Einhell","priceSegment":"günstig","useCases":["Möbel aufbauen","Bilder aufhängen","Heimwerken"],"features":["18 V Power X-Change","40 Nm","LED-Licht","2-Gang"]}'),
    ('prod-010', '{"name":"Bosch Bohrhammer GBH 2-28 F","category":"Elektrowerkzeuge","subCategory":"Bohrhämmer","brand":"Bosch","priceSegment":"premium","useCases":["Beton bohren","Meißeln","Dübellöcher setzen"],"features":["SDS-plus","Wechselfutter","880 W","3,2 J Schlagenergie"]}'),
    ('prod-011', '{"name":"Hilti Bohrhammer TE 30-AVR","category":"Elektrowerkzeuge","subCategory":"Bohrhämmer","brand":"Hilti","priceSegment":"premium","useCases":["Beton bohren","Durchbrüche erstellen","Profi-Baustelle"],"features":["SDS-plus","aktive Vibrationsreduktion","3,3 J","Staubabsaugung anschließbar"]}'),
    ('prod-012', '{"name":"Bosch Akku-Schlagschrauber GDX 18V-200","category":"Elektrowerkzeuge","subCategory":"Bohren und Schrauben","brand":"Bosch","priceSegment":"mittel","useCases":["Festsitzende Schrauben lösen","Radwechsel","Holzbau"],"features":["18 V","200 Nm","Innensechskant- und Vierkantaufnahme"]}'),

    -- === Elektrowerkzeuge: Schleifen und Fräsen =============================
    ('prod-013', '{"name":"Metabo Winkelschleifer W 850-125","category":"Elektrowerkzeuge","subCategory":"Schleifer","brand":"Metabo","priceSegment":"mittel","useCases":["Fliesen schneiden","Metall trennen","Rost entfernen"],"features":["125 mm Scheibe","850 W","Totmannschalter","Zusatzhandgriff"]}'),
    ('prod-014', '{"name":"Bosch Exzenterschleifer PEX 400 AE","category":"Elektrowerkzeuge","subCategory":"Schleifer","brand":"Bosch","priceSegment":"mittel","useCases":["Lack abschleifen","Holzoberflächen glätten","Renovieren"],"features":["125 mm Schleifteller","Microfilter-Absaugung","350 W","Drehzahlvorwahl"]}'),
    ('prod-015', '{"name":"Makita Akku-Bandschleifer DBS180Z","category":"Elektrowerkzeuge","subCategory":"Schleifer","brand":"Makita","priceSegment":"mittel","useCases":["Kanten schleifen","Grobschliff an Holz","Metall entgraten"],"features":["18 V LXT","Schleifband 9x533 mm","Staubbeutel"]}'),
    ('prod-016', '{"name":"Festool Oberfräse OF 1010 EBQ","category":"Elektrowerkzeuge","subCategory":"Fräsen","brand":"Festool","priceSegment":"premium","useCases":["Nuten fräsen","Kantenprofile erstellen","Möbelbau"],"features":["1010 W","Absauganschluss","Feineinstellung der Frästiefe"]}'),
    ('prod-017', '{"name":"Bosch Multifunktionswerkzeug PMF 350 CES","category":"Elektrowerkzeuge","subCategory":"Multitool","brand":"Bosch","priceSegment":"mittel","useCases":["Fugen entfernen","Tauchschnitte in Holz","Renovieren"],"features":["oszillierend","Starlock-Aufnahme","350 W","werkzeugloser Zubehörwechsel"]}'),
    ('prod-018', '{"name":"Bosch Heißluftpistole GHG 20-60","category":"Elektrowerkzeuge","subCategory":"Sonstige Elektrowerkzeuge","brand":"Bosch","priceSegment":"mittel","useCases":["Alte Farbe entfernen","Schrumpfschläuche verarbeiten","Rohre auftauen"],"features":["2000 W","50 bis 600 Grad","Digitalanzeige"]}'),

    -- === Handwerkzeuge ======================================================
    ('prod-019', '{"name":"Stanley FatMax Schlosserhammer 450 g","category":"Handwerkzeuge","subCategory":"Hämmer","brand":"Stanley","priceSegment":"mittel","useCases":["Nägel einschlagen","Abbrucharbeiten","Montage"],"features":["Stahlrohrstiel","Anti-Vibrations-Griff","450 g"]}'),
    ('prod-020', '{"name":"Picard Latthammer 600 g","category":"Handwerkzeuge","subCategory":"Hämmer","brand":"Picard","priceSegment":"premium","useCases":["Dachlatten nageln","Zimmererarbeiten","Nägel ziehen"],"features":["geschmiedet","Magnet-Nagelhalter","Nagelklaue","600 g"]}'),
    ('prod-021', '{"name":"Wera Schraubendreher-Set Kraftform Plus 6-teilig","category":"Handwerkzeuge","subCategory":"Schraubendreher","brand":"Wera","priceSegment":"premium","useCases":["Möbelmontage","Elektroarbeiten","Feinmechanik"],"features":["Kraftform-Mehrkomponentengriff","Schlitz und Kreuz","Lasertip"]}'),
    ('prod-022', '{"name":"Wiha Bit-Set 40-teilig","category":"Handwerkzeuge","subCategory":"Schraubendreher","brand":"Wiha","priceSegment":"mittel","useCases":["Schrauben eindrehen","Zubehör für Akkuschrauber","Möbelaufbau"],"features":["Torx","Kreuz","Schlitz","Innensechskant","Magnethalter"]}'),
    ('prod-023', '{"name":"Knipex Kombizange 180 mm","category":"Handwerkzeuge","subCategory":"Zangen","brand":"Knipex","priceSegment":"premium","useCases":["Draht schneiden","Werkstücke greifen","Elektroinstallation"],"features":["Chrom-Vanadium-Stahl","Mehrkomponenten-Hüllen","180 mm"]}'),
    ('prod-024', '{"name":"Knipex Wasserpumpenzange Cobra 250 mm","category":"Handwerkzeuge","subCategory":"Zangen","brand":"Knipex","priceSegment":"premium","useCases":["Rohre greifen","Sanitärinstallation","Verschraubungen lösen"],"features":["selbstklemmend","25 Einstellungen","Druckknopfverstellung"]}'),
    ('prod-025', '{"name":"Gedore Ring-Maulschlüssel-Satz 8 bis 22 mm","category":"Handwerkzeuge","subCategory":"Schraubenschlüssel","brand":"Gedore","priceSegment":"premium","useCases":["Schrauben lösen","Maschinenmontage","KFZ-Reparatur"],"features":["12-teilig","Chrom-Vanadium","Rolltasche"]}'),
    ('prod-026', '{"name":"Hazet Steckschlüsselsatz 42-teilig","category":"Handwerkzeuge","subCategory":"Schraubenschlüssel","brand":"Hazet","priceSegment":"premium","useCases":["Verschraubungen lösen","Werkstattarbeit","Fahrzeugwartung"],"features":["Halbzoll-Antrieb","Umschaltknarre","42 Teile im Koffer"]}'),
    ('prod-027', '{"name":"Stanley Cuttermesser FatMax","category":"Handwerkzeuge","subCategory":"Messer und Scheren","brand":"Stanley","priceSegment":"günstig","useCases":["Tapeten schneiden","Karton öffnen","Dämmung zuschneiden"],"features":["Abbrechklinge 18 mm","Metallgehäuse","Klingenmagazin"]}'),
    ('prod-028', '{"name":"Fiskars Handsäge Xtract 350 mm","category":"Handwerkzeuge","subCategory":"Handsägen","brand":"Fiskars","priceSegment":"mittel","useCases":["Holz sägen","Äste kürzen","Heimwerken"],"features":["hartgezahnt","SoftGrip-Griff","350 mm Blattlänge"]}'),
    ('prod-029', '{"name":"Bessey Schraubzwinge TG 300 mm","category":"Handwerkzeuge","subCategory":"Spannwerkzeuge","brand":"Bessey","priceSegment":"mittel","useCases":["Werkstücke fixieren","Verleimen","Möbelbau"],"features":["Spannweite 300 mm","Ausladung 120 mm","Holzgriff"]}'),
    ('prod-030', '{"name":"Stanley Gliedermaßstab 2 m","category":"Handwerkzeuge","subCategory":"Messen und Anreißen","brand":"Stanley","priceSegment":"günstig","useCases":["Maße abnehmen","Zuschnitt anzeichnen","Baustelle"],"features":["Holz","2 m","10 Glieder"]}'),

    -- === Messtechnik ========================================================
    ('prod-031', '{"name":"Bosch Laser-Entfernungsmesser GLM 50 C","category":"Messtechnik","subCategory":"Entfernungsmesser","brand":"Bosch","priceSegment":"mittel","useCases":["Räume ausmessen","Flächen berechnen","Angebote kalkulieren"],"features":["50 m Reichweite","Bluetooth","Neigungssensor","Farbdisplay"]}'),
    ('prod-032', '{"name":"Leica DISTO D2 Laser-Entfernungsmesser","category":"Messtechnik","subCategory":"Entfernungsmesser","brand":"Leica","priceSegment":"premium","useCases":["Innenräume vermessen","Aufmaß erstellen","Daten übertragen"],"features":["100 m Reichweite","Bluetooth","ausklappbares Endstück"]}'),
    ('prod-033', '{"name":"Bosch Kreuzlinienlaser Quigo Green","category":"Messtechnik","subCategory":"Laser","brand":"Bosch","priceSegment":"günstig","useCases":["Bilder ausrichten","Fliesen verlegen","Regale montieren"],"features":["grüner Laser","selbstnivellierend","12 m Arbeitsbereich"]}'),
    ('prod-034', '{"name":"Stabila Wasserwaage 96-2 100 cm","category":"Messtechnik","subCategory":"Wasserwaagen","brand":"Stabila","priceSegment":"premium","useCases":["Mauern richten","Türzargen setzen","Nivellieren"],"features":["Aluminium-Profil","3 Libellen","100 cm"]}'),
    ('prod-035', '{"name":"Bosch Ortungsgerät GMS 120","category":"Messtechnik","subCategory":"Ortungsgeräte","brand":"Bosch","priceSegment":"mittel","useCases":["Leitungen orten","Metall im Mauerwerk finden","Bohren vorbereiten"],"features":["erkennt Metall","erkennt Stromleitungen","erkennt Holzunterkonstruktion"]}'),

    -- === Garten =============================================================
    ('prod-036', '{"name":"Gardena Elektro-Rasenmäher PowerMax 1400/34","category":"Garten","subCategory":"Rasenpflege","brand":"Gardena","priceSegment":"mittel","useCases":["Rasen mähen","Kleiner Hausgarten","Gras auffangen"],"features":["1400 W","34 cm Schnittbreite","40 l Fangkorb","zentrale Schnitthöhenverstellung"]}'),
    ('prod-037', '{"name":"Husqvarna Automower 310 Mark II","category":"Garten","subCategory":"Rasenpflege","brand":"Husqvarna","priceSegment":"premium","useCases":["Rasen automatisch mähen","Zeitersparnis","Gleichmäßiges Schnittbild"],"features":["Mähroboter","App-Steuerung","bis 1000 Quadratmeter","Diebstahlschutz"]}'),
    ('prod-038', '{"name":"Stihl Benzin-Rasenmäher RM 448 T","category":"Garten","subCategory":"Rasenpflege","brand":"Stihl","priceSegment":"premium","useCases":["Große Rasenflächen mähen","Unabhängig von der Steckdose","Hohes Gras"],"features":["Benzinmotor","46 cm Schnittbreite","Radantrieb","55 l Fangkorb"]}'),
    ('prod-039', '{"name":"Einhell Akku-Rasentrimmer GE-CT 18/28 Li","category":"Garten","subCategory":"Rasenpflege","brand":"Einhell","priceSegment":"günstig","useCases":["Rasenkanten schneiden","Unkraut entfernen","Schwer zugängliche Stellen"],"features":["18 V Power X-Change","28 cm Schnittkreis","Fadenspule","schwenkbarer Kopf"]}'),
    ('prod-040', '{"name":"Stihl Motorsäge MS 170","category":"Garten","subCategory":"Baumschnitt","brand":"Stihl","priceSegment":"mittel","useCases":["Brennholz sägen","Äste absägen","Kleine Bäume fällen"],"features":["Benzinmotor","30 cm Schwert","1,2 kW","Kettenschnellspannung"]}'),
    ('prod-041', '{"name":"Bosch Akku-Heckenschere AHS 50-20 LI","category":"Garten","subCategory":"Baumschnitt","brand":"Bosch","priceSegment":"mittel","useCases":["Hecke schneiden","Sträucher formen","Gartenpflege"],"features":["18 V","50 cm Messerlänge","Antiblockiersystem","20 mm Schnittstärke"]}'),
    ('prod-042', '{"name":"Fiskars Astschere PowerGear X","category":"Garten","subCategory":"Baumschnitt","brand":"Fiskars","priceSegment":"premium","useCases":["Dicke Äste schneiden","Obstbaumschnitt","Straucherneuerung"],"features":["Getriebeübersetzung","bis 55 mm Astdurchmesser","Bypass-Klinge"]}'),
    ('prod-043', '{"name":"Gardena Bewässerungscomputer FlexControl","category":"Garten","subCategory":"Bewässerung","brand":"Gardena","priceSegment":"mittel","useCases":["Automatisch bewässern","Urlaubsbewässerung","Wasser sparen"],"features":["digitale Zeitsteuerung","Batteriebetrieb","Regenverzögerung"]}'),
    ('prod-044', '{"name":"Gardena Schlauchwagen 60 HD","category":"Garten","subCategory":"Bewässerung","brand":"Gardena","priceSegment":"mittel","useCases":["Gartenschlauch aufrollen","Beete gießen","Ordnung im Garten"],"features":["für 60 m Schlauch","Metallgestell","Kurbel mit Klappgriff"]}'),
    ('prod-045', '{"name":"Kärcher Hochdruckreiniger K 5 Premium Smart Control","category":"Garten","subCategory":"Reinigungsgeräte","brand":"Kärcher","priceSegment":"mittel","useCases":["Terrasse reinigen","Auto waschen","Fassade säubern"],"features":["145 bar","Flächenreiniger","Schlauchtrommel","App-Steuerung"]}'),
    ('prod-046', '{"name":"Einhell Akku-Laubbläser GE-CL 18 Li","category":"Garten","subCategory":"Gartenreinigung","brand":"Einhell","priceSegment":"günstig","useCases":["Laub entfernen","Wege säubern","Herbstarbeiten"],"features":["18 V Power X-Change","Blas- und Saugfunktion","Häcksler","Fangsack"]}'),
    ('prod-047', '{"name":"Compo Rasendünger Floranid 20 kg","category":"Garten","subCategory":"Pflanzenpflege","brand":"Compo","priceSegment":"mittel","useCases":["Rasen düngen","Moos vorbeugen","Dichten Rasen fördern"],"features":["Langzeitwirkung 3 Monate","20 kg für 600 Quadratmeter","mit Eisen"]}'),
    ('prod-048', '{"name":"Floragard Blumenerde 70 l","category":"Garten","subCategory":"Pflanzenpflege","brand":"Floragard","priceSegment":"günstig","useCases":["Pflanzen umtopfen","Beete anlegen","Balkonkästen befüllen"],"features":["torfreduziert","70 l","mit Startdünger"]}'),
    ('prod-049', '{"name":"Fiskars Spaten Solid","category":"Garten","subCategory":"Gartenhandwerkzeug","brand":"Fiskars","priceSegment":"mittel","useCases":["Erde umgraben","Pflanzlöcher ausheben","Beet vorbereiten"],"features":["gehärteter Stahl","Trittkante","D-Griff"]}'),

    -- === Farben und Lacke ===================================================
    ('prod-050', '{"name":"Alpina Wandfarbe Das Original 10 l","category":"Farben und Lacke","subCategory":"Wandfarbe","brand":"Alpina","priceSegment":"mittel","useCases":["Innenwände streichen","Decken streichen","Renovieren"],"features":["weiß matt","10 l","hohe Deckkraft","tropfgehemmt"]}'),
    ('prod-051', '{"name":"Schöner Wohnen Trendfarbe Polarweiß 2,5 l","category":"Farben und Lacke","subCategory":"Wandfarbe","brand":"Schöner Wohnen","priceSegment":"premium","useCases":["Akzentwand gestalten","Wohnraum streichen","Farbgestaltung"],"features":["matt","2,5 l","scheuerbeständig","geruchsarm"]}'),
    ('prod-052', '{"name":"Baufix Wandfarbe Weiß 10 l","category":"Farben und Lacke","subCategory":"Wandfarbe","brand":"Baufix","priceSegment":"günstig","useCases":["Mietwohnung streichen","Große Flächen","Schnelle Renovierung"],"features":["weiß matt","10 l","lösemittelfrei"]}'),
    ('prod-053', '{"name":"Alpina Buntlack Seidenmatt Weiß 750 ml","category":"Farben und Lacke","subCategory":"Lacke","brand":"Alpina","priceSegment":"mittel","useCases":["Türen lackieren","Heizkörper streichen","Holz lackieren"],"features":["wasserbasiert","seidenmatt","750 ml","vergilbungsfrei"]}'),
    ('prod-054', '{"name":"Bondex Holzlasur Dauerschutz 2,5 l","category":"Farben und Lacke","subCategory":"Lasuren","brand":"Bondex","priceSegment":"mittel","useCases":["Gartenzaun streichen","Holzschutz im Außenbereich","Gartenhaus pflegen"],"features":["UV-Schutz","Wetterschutz","Farbton Nussbaum","2,5 l"]}'),
    ('prod-055', '{"name":"Xyladecor Holzschutz-Grundierung 2,5 l","category":"Farben und Lacke","subCategory":"Lasuren","brand":"Xyladecor","priceSegment":"mittel","useCases":["Holz grundieren","Bläueschutz","Vorbereitung für Lasur"],"features":["farblos","Bläueschutz","Insektenschutz","2,5 l"]}'),
    ('prod-056', '{"name":"Caparol Tiefgrund LF 10 l","category":"Farben und Lacke","subCategory":"Grundierungen","brand":"Caparol","priceSegment":"mittel","useCases":["Untergrund vorbereiten","Saugende Wände grundieren","Altbau sanieren"],"features":["lösemittelfrei","10 l","verfestigt den Untergrund"]}'),
    ('prod-057', '{"name":"Storch Malerwalzen-Set 25 cm","category":"Farben und Lacke","subCategory":"Malerzubehör","brand":"Storch","priceSegment":"günstig","useCases":["Wände streichen","Farbe auftragen","Heimwerken"],"features":["Walze 25 cm","Bügel","Abstreifgitter","Farbwanne"]}'),
    ('prod-058', '{"name":"Tesa Malerkrepp Präzision 50 m","category":"Farben und Lacke","subCategory":"Malerzubehör","brand":"Tesa","priceSegment":"mittel","useCases":["Kanten abkleben","Saubere Farbübergänge","Fenster schützen"],"features":["30 mm breit","50 m","rückstandsfrei ablösbar"]}'),
    ('prod-059', '{"name":"Dulux Fassadenfarbe Weiß 10 l","category":"Farben und Lacke","subCategory":"Fassadenfarbe","brand":"Dulux","priceSegment":"premium","useCases":["Fassade streichen","Wetterschutz außen","Algenbefall vorbeugen"],"features":["wetterbeständig","atmungsaktiv","10 l","algenhemmend"]}'),

    -- === Sanitär ============================================================
    ('prod-060', '{"name":"Grohe Eurosmart Waschtischarmatur","category":"Sanitär","subCategory":"Armaturen","brand":"Grohe","priceSegment":"mittel","useCases":["Waschbecken ausstatten","Bad renovieren","Gäste-WC"],"features":["Chrom","Einhebelmischer","SilkMove-Kartusche","Wassersparfunktion"]}'),
    ('prod-061', '{"name":"Hansgrohe Croma 100 Duschset","category":"Sanitär","subCategory":"Armaturen","brand":"Hansgrohe","priceSegment":"premium","useCases":["Dusche nachrüsten","Bad modernisieren","Duschkomfort erhöhen"],"features":["3 Strahlarten","Brausestange 90 cm","Kalkschutz","Chrom"]}'),
    ('prod-062', '{"name":"Cornat Spültischarmatur Basic","category":"Sanitär","subCategory":"Armaturen","brand":"Cornat","priceSegment":"günstig","useCases":["Küchenspüle ausstatten","Mietwohnung","Schneller Austausch"],"features":["Chrom","schwenkbarer Auslauf","Einhebelmischer"]}'),
    ('prod-063', '{"name":"Geberit Spülkasten Duofix UP320","category":"Sanitär","subCategory":"WC","brand":"Geberit","priceSegment":"premium","useCases":["WC installieren","Unterputz-Montage","Bad neu bauen"],"features":["Unterputz","2-Mengen-Spülung","Montagerahmen","schallgedämmt"]}'),
    ('prod-064', '{"name":"Villeroy und Boch WC O.novo spülrandlos","category":"Sanitär","subCategory":"WC","brand":"Villeroy und Boch","priceSegment":"premium","useCases":["WC ersetzen","Bad renovieren","Leichte Reinigung"],"features":["spülrandlos","wandhängend","DirectFlush","Keramik"]}'),
    ('prod-065', '{"name":"Viega Pressfitting-Set 16 mm","category":"Sanitär","subCategory":"Rohre und Fittings","brand":"Viega","priceSegment":"mittel","useCases":["Wasserleitung verlegen","Heizungsrohre verbinden","Sanitärinstallation"],"features":["Pressverbindung","16 mm","SC-Contur Sicherheitsfunktion"]}'),
    ('prod-066', '{"name":"Gebo Mehrschichtverbundrohr 16x2 mm 50 m","category":"Sanitär","subCategory":"Rohre und Fittings","brand":"Gebo","priceSegment":"günstig","useCases":["Fußbodenheizung verlegen","Wasserinstallation","Sanitär-Rohbau"],"features":["16x2 mm","50 m Ring","sauerstoffdicht","biegsam"]}'),
    ('prod-067', '{"name":"Cornat Waschtisch-Siphon Chrom","category":"Sanitär","subCategory":"Abflüsse","brand":"Cornat","priceSegment":"günstig","useCases":["Waschbecken anschließen","Abfluss montieren","Geruchsverschluss herstellen"],"features":["Chrom","Röhrengeruchsverschluss","Anschluss 1 1/4 Zoll"]}'),

    -- === Elektroinstallation ================================================
    ('prod-068', '{"name":"Gira System 55 Wippschalter Reinweiß","category":"Elektroinstallation","subCategory":"Schalter und Steckdosen","brand":"Gira","priceSegment":"mittel","useCases":["Lichtschalter tauschen","Renovierung","Einheitliches Schalterbild"],"features":["System 55","reinweiß glänzend","Wechselschalter","Unterputz"]}'),
    ('prod-069', '{"name":"Busch-Jaeger Steckdose Balance SI","category":"Elektroinstallation","subCategory":"Schalter und Steckdosen","brand":"Busch-Jaeger","priceSegment":"mittel","useCases":["Steckdose nachrüsten","Wohnraum ausstatten","Renovieren"],"features":["Schuko","erhöhter Berührungsschutz","Unterputz","alpinweiß"]}'),
    ('prod-070', '{"name":"Brennenstuhl Steckdosenleiste 6-fach mit Überspannungsschutz","category":"Elektroinstallation","subCategory":"Verlängerungen","brand":"Brennenstuhl","priceSegment":"günstig","useCases":["Arbeitsplatz verkabeln","Geräte schützen","Büro einrichten"],"features":["6 Steckdosen","Schalter","3 m Kabel","Überspannungsschutz"]}'),
    ('prod-071', '{"name":"Lapp NYM-J 3x1,5 Installationsleitung 50 m","category":"Elektroinstallation","subCategory":"Kabel und Leitungen","brand":"Lapp","priceSegment":"mittel","useCases":["Steckdosen verkabeln","Unterputz-Installation","Neubau verkabeln"],"features":["3x1,5 Quadratmillimeter","50 m Ring","grau","für feste Verlegung"]}'),
    ('prod-072', '{"name":"Osram LED-Lampe E27 Warmweiß 4er-Pack","category":"Elektroinstallation","subCategory":"Leuchtmittel","brand":"Osram","priceSegment":"günstig","useCases":["Wohnraum beleuchten","Glühbirne ersetzen","Stromkosten senken"],"features":["E27","8,5 W","2700 Kelvin","806 Lumen"]}'),
    ('prod-073', '{"name":"Philips Hue White and Color Ambiance E27","category":"Elektroinstallation","subCategory":"Leuchtmittel","brand":"Philips","priceSegment":"premium","useCases":["Smart Home einrichten","Lichtstimmung steuern","Per App dimmen"],"features":["Zigbee","16 Millionen Farben","dimmbar","Sprachsteuerung"]}'),
    ('prod-074', '{"name":"Ledvance LED-Feuchtraumleuchte 150 cm","category":"Elektroinstallation","subCategory":"Leuchten","brand":"Ledvance","priceSegment":"mittel","useCases":["Garage beleuchten","Keller ausleuchten","Werkstatt beleuchten"],"features":["IP65","4000 Kelvin","150 cm","5000 Lumen"]}'),
    ('prod-075', '{"name":"Hager Leitungsschutzschalter B16","category":"Elektroinstallation","subCategory":"Sicherungen","brand":"Hager","priceSegment":"mittel","useCases":["Stromkreis absichern","Verteiler bestücken","Altbau nachrüsten"],"features":["B-Charakteristik","16 A","1-polig","6 kA Schaltvermögen"]}'),

    -- === Baustoffe ==========================================================
    ('prod-076', '{"name":"Knauf Rotband Haftputz 25 kg","category":"Baustoffe","subCategory":"Putz und Mörtel","brand":"Knauf","priceSegment":"mittel","useCases":["Innenwände verputzen","Untergrund ausgleichen","Altbau sanieren"],"features":["Gipsputz","25 kg","für Innenbereich","glättbar"]}'),
    ('prod-077', '{"name":"Sakret Zementmörtel 25 kg","category":"Baustoffe","subCategory":"Putz und Mörtel","brand":"Sakret","priceSegment":"günstig","useCases":["Mauern","Fundamente setzen","Ausbesserungsarbeiten"],"features":["25 kg","Zementbasis","frostbeständig","außen und innen"]}'),
    ('prod-078', '{"name":"Ceresit Flexkleber CM 16 25 kg","category":"Baustoffe","subCategory":"Fliesenkleber","brand":"Ceresit","priceSegment":"mittel","useCases":["Fliesen verlegen","Bad fliesen","Bodenfliesen kleben"],"features":["C2TE","25 kg","flexibel","für Fußbodenheizung geeignet"]}'),
    ('prod-079', '{"name":"Knauf Gipskartonplatte 2000x1250x12,5 mm","category":"Baustoffe","subCategory":"Trockenbau","brand":"Knauf","priceSegment":"günstig","useCases":["Trockenbauwand errichten","Decke abhängen","Dachausbau"],"features":["12,5 mm stark","2,5 Quadratmeter","GKB","abgeflachte Kante"]}'),
    ('prod-080', '{"name":"Isover Mineralwolle Klemmfilz 035","category":"Baustoffe","subCategory":"Dämmung","brand":"Isover","priceSegment":"mittel","useCases":["Dach dämmen","Zwischensparrendämmung","Energie sparen"],"features":["WLG 035","140 mm","nicht brennbar","klemmt ohne Befestigung"]}'),
    ('prod-081', '{"name":"Ursa XPS Dämmplatte 50 mm","category":"Baustoffe","subCategory":"Dämmung","brand":"Ursa","priceSegment":"mittel","useCases":["Perimeterdämmung","Keller dämmen","Bodenplatte dämmen"],"features":["50 mm","druckfest","feuchtigkeitsunempfindlich","Stufenfalz"]}'),
    ('prod-082', '{"name":"Ceresit Dichtschlämme CR 65 20 kg","category":"Baustoffe","subCategory":"Abdichtung","brand":"Ceresit","priceSegment":"mittel","useCases":["Keller abdichten","Feuchtigkeitsschutz","Balkon abdichten"],"features":["20 kg","mineralisch","starre Abdichtung","innen und außen"]}'),

    -- === Befestigungstechnik ================================================
    ('prod-083', '{"name":"Fischer Dübel-Sortiment UX 200-teilig","category":"Befestigungstechnik","subCategory":"Dübel","brand":"Fischer","priceSegment":"mittel","useCases":["Bilder aufhängen","Regale montieren","Universalbefestigung"],"features":["Universaldübel","200 Teile","Sortimentsbox","für alle Baustoffe"]}'),
    ('prod-084', '{"name":"Fischer Duopower 8x40 100 Stück","category":"Befestigungstechnik","subCategory":"Dübel","brand":"Fischer","priceSegment":"mittel","useCases":["Schwere Lasten befestigen","Beton","Hohlwand"],"features":["Zwei-Komponenten-Dübel","8x40 mm","100 Stück","spreizt und knotet"]}'),
    ('prod-085', '{"name":"Würth Spanplattenschrauben 4x40 500 Stück","category":"Befestigungstechnik","subCategory":"Schrauben","brand":"Würth","priceSegment":"mittel","useCases":["Holzverbindungen","Möbelbau","Lattung befestigen"],"features":["Torx-Antrieb","verzinkt","Senkkopf","500 Stück"]}'),
    ('prod-086', '{"name":"Pattex Montagekleber Kraft-Mix 400 g","category":"Befestigungstechnik","subCategory":"Kleber","brand":"Pattex","priceSegment":"mittel","useCases":["Leisten kleben","Spiegel befestigen","Ohne Bohren montieren"],"features":["400 g Kartusche","hohe Anfangshaftung","innen und außen"]}'),
    ('prod-087', '{"name":"Sika Sanitärsilikon 300 ml","category":"Befestigungstechnik","subCategory":"Dichtstoffe","brand":"Sika","priceSegment":"mittel","useCases":["Fugen abdichten","Dusche abdichten","Waschbecken anschließen"],"features":["schimmelhemmend","transparent","300 ml","dauerelastisch"]}'),
    ('prod-088', '{"name":"GAH Alberts Winkelverbinder 90x90 mm 25 Stück","category":"Befestigungstechnik","subCategory":"Verbinder","brand":"GAH Alberts","priceSegment":"günstig","useCases":["Holzkonstruktionen verbinden","Carport bauen","Terrasse bauen"],"features":["verzinkt","gelocht","90x90 mm","25 Stück"]}'),

    -- === Bodenbeläge ========================================================
    ('prod-089', '{"name":"Egger Laminat Home Eiche natur 8 mm","category":"Bodenbeläge","subCategory":"Laminat","brand":"Egger","priceSegment":"mittel","useCases":["Wohnzimmer verlegen","Schlafzimmer verlegen","Renovieren ohne Kleber"],"features":["Klick-System","8 mm","Nutzungsklasse 31","Eiche-Dekor"]}'),
    ('prod-090', '{"name":"Parador Vinylboden Basic 30 Eiche","category":"Bodenbeläge","subCategory":"Vinyl","brand":"Parador","priceSegment":"premium","useCases":["Küche verlegen","Feuchträume","Stark beanspruchte Räume"],"features":["Klick-Vinyl","wasserfest","warm und leise","Eiche-Dekor"]}'),
    ('prod-091', '{"name":"Logoclic Laminat Ceramico","category":"Bodenbeläge","subCategory":"Laminat","brand":"Logoclic","priceSegment":"günstig","useCases":["Günstig renovieren","Mietwohnung","Fliesenoptik ohne Fliesen"],"features":["Klick-System","7 mm","Fliesenoptik","Nutzungsklasse 23"]}'),
    ('prod-092', '{"name":"Villeroy und Boch Feinsteinzeug Bodenfliese 60x60","category":"Bodenbeläge","subCategory":"Fliesen","brand":"Villeroy und Boch","priceSegment":"premium","useCases":["Bad fliesen","Wohnbereich fliesen","Fußbodenheizung"],"features":["Feinsteinzeug","60x60 cm","rektifiziert","matt"]}'),
    ('prod-093', '{"name":"Selit Trittschalldämmung 5 mm 15 Quadratmeter","category":"Bodenbeläge","subCategory":"Bodenzubehör","brand":"Selit","priceSegment":"günstig","useCases":["Laminat unterlegen","Trittschall reduzieren","Unebenheiten ausgleichen"],"features":["5 mm","integrierte Dampfsperre","15 Quadratmeter Rolle"]}'),
    ('prod-094', '{"name":"Knauf Nivellierspachtel 25 kg","category":"Bodenbeläge","subCategory":"Bodenzubehör","brand":"Knauf","priceSegment":"mittel","useCases":["Boden ausgleichen","Untergrund vorbereiten","Estrich glätten"],"features":["selbstverlaufend","25 kg","2 bis 20 mm Schichtdicke","schnell begehbar"]}'),

    -- === Arbeitsschutz, Werkstatt und Lagerung ==============================
    ('prod-095', '{"name":"Uvex Schutzbrille i-3","category":"Arbeitsschutz","subCategory":"Augenschutz","brand":"Uvex","priceSegment":"mittel","useCases":["Augen schützen","Flexen","Schleifarbeiten"],"features":["kratzfest","beschlagfrei","UV-Schutz","verstellbare Bügel"]}'),
    ('prod-096', '{"name":"3M Peltor Optime III Kapselgehörschutz","category":"Arbeitsschutz","subCategory":"Gehörschutz","brand":"3M","priceSegment":"premium","useCases":["Lärmschutz","Arbeiten mit der Motorsäge","Baustelle"],"features":["SNR 35 dB","Kapselgehörschutz","Kopfbügel","doppelschalig"]}'),
    ('prod-097', '{"name":"Engelbert Strauss Montagehandschuhe","category":"Arbeitsschutz","subCategory":"Handschuhe","brand":"Engelbert Strauss","priceSegment":"mittel","useCases":["Montagearbeiten","Sicherer Griff","Schutz vor Schnitten"],"features":["Nitril-Beschichtung","Größe 10","atmungsaktiv","touchscreenfähig"]}'),
    ('prod-098', '{"name":"3M Atemschutzmaske FFP2 20 Stück","category":"Arbeitsschutz","subCategory":"Atemschutz","brand":"3M","priceSegment":"mittel","useCases":["Staubschutz","Schleifarbeiten","Dämmung einbauen"],"features":["FFP2","20 Stück","Ausatemventil","faltbar"]}'),
    ('prod-099', '{"name":"Hailo Alu-Stehleiter 6 Stufen","category":"Werkstatt und Lagerung","subCategory":"Leitern","brand":"Hailo","priceSegment":"mittel","useCases":["Decke streichen","Lampen montieren","Arbeiten in der Höhe"],"features":["Aluminium","6 Stufen","EN 131","rutschhemmende Füße"]}'),
    ('prod-100', '{"name":"Stanley Werkzeugkoffer FatMax 23 Zoll","category":"Werkstatt und Lagerung","subCategory":"Aufbewahrung","brand":"Stanley","priceSegment":"mittel","useCases":["Werkzeug transportieren","Ordnung halten","Mobiler Einsatz"],"features":["Metallschließen","wasserabweisend","23 Zoll","herausnehmbare Einsätze"]}')
)
INSERT INTO documents (external_id, content, meta)
SELECT r.external_id,
       render_product(r.meta::jsonb),
       r.meta::jsonb
FROM raw r
ON CONFLICT (external_id) DO UPDATE
    SET content = EXCLUDED.content,
        meta    = EXCLUDED.meta;

COMMIT;

\echo ''
\echo '--- Produkte pro Kategorie ---'
SELECT meta ->> 'category' AS kategorie, count(*)
FROM documents
GROUP BY 1 ORDER BY 2 DESC, 1;

\echo '--- Preissegmente ---'
SELECT meta ->> 'priceSegment' AS segment, count(*)
FROM documents
GROUP BY 1 ORDER BY 2 DESC;

\echo '--- Beispiel: so sieht der eingebettete Text aus ---'
SELECT content FROM documents WHERE external_id = 'prod-001';
