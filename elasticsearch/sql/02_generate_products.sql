-- Adds 2 million generated products for load testing. All of them have a SKU starting with "GEN-".
-- Names and descriptions are combined from word lists plus a model code, so the index gets
-- a realistic, large vocabulary.
--
-- Every row gets its own updated_at (1 microsecond apart, just before now()), so the
-- Logstash sync can page through them in a stable order.
--
-- Remove them again (deletes are not synced, so clean up both sides):
--   DELETE FROM products WHERE sku LIKE 'GEN-%';
--   POST /products/_delete_by_query  {"query": {"prefix": {"sku": "GEN-"}}}

SELECT setseed(0.42);

WITH words AS (
    SELECT
        ARRAY['Compact','Pro','Ultra','Slim','Smart','Rugged','Silent','Wireless','Portable','Premium',
              'Classic','Advanced','Eco','Turbo','Nano','Max','Flex','Studio','Travel','Gaming',
              'Office','Home','Elite','Lite','Prime','Fusion','Vision','Swift','Solid','Zen'] AS adj,
        ARRAY['Laptop','Notebook','Monitor','Display','Keyboard','Mouse','Trackpad','Headphones','Headset','Earbuds',
              'Speaker','Soundbar','Webcam','Microphone','Docking Station','USB Hub','SSD','Hard Drive','Memory Card','Router',
              'Mesh System','Switch','Access Point','Office Chair','Standing Desk','Desk Lamp','Monitor Arm','Charger','Power Bank','Cable'] AS kind,
        ARRAY['Laptops','Laptops','Monitors','Monitors','Accessories','Accessories','Accessories','Audio','Audio','Audio',
              'Audio','Audio','Video','Audio','Accessories','Accessories','Storage','Storage','Storage','Networking',
              'Networking','Networking','Networking','Furniture','Furniture','Furniture','Furniture','Power','Power','Accessories'] AS kind_category,
        ARRAY['laptop','laptop','monitor','monitor','keyboard','mouse','trackpad','headphones','headset','earbuds',
              'speaker','soundbar','webcam','microphone','dock','hub','ssd','hdd','memory-card','router',
              'mesh','switch','access-point','chair','desk','lamp','monitor-arm','charger','power-bank','cable'] AS kind_tag,
        ARRAY['Novatek','Titan','Lumina','Keyforge','Ergonix','Sonora','Vertex','Aurora','Kestrel','Orbis',
              'Quantix','Nordline','Helix','Pulsar','Zephyr'] AS brand,
        ARRAY['a long-lasting battery','fast USB-C charging','Bluetooth 5.4 connectivity','active noise cancellation',
              'a brushed aluminium body','an ergonomic design','a water-resistant housing','silent operation',
              'a high refresh rate','HDR support','a backlit layout','low-latency wireless','energy-saving standby',
              'a detachable cable','a carrying case','tool-free assembly','a three-year warranty','recycled materials',
              'automatic firmware updates','multi-device pairing','a high-precision sensor','fanless cooling',
              'a compact footprint','adjustable height','dual-band Wi-Fi','Thunderbolt support','a matte finish',
              'magnetic mounting','voice assistant support','an anti-glare coating'] AS feature,
        ARRAY['battery','usb-c','bluetooth','anc','aluminium','ergonomic','waterproof','silent',
              'high-refresh','hdr','backlit','low-latency','eco','detachable','case','tool-free','warranty','recycled',
              'firmware','multi-device','precision','fanless','compact','adjustable','dual-band','thunderbolt','matte',
              'magnetic','voice','anti-glare'] AS feature_tag,
        ARRAY['Ideal for home offices.','Built for gamers and streamers.','Made for students on the go.',
              'Designed for creative professionals.','Perfect for frequent travellers.','Great for small businesses.',
              'A reliable choice for everyday use.','Engineered for demanding workloads.'] AS audience
),
picks AS (
    SELECT g.i,
           1 + floor(random() * 30)::int AS a,
           1 + floor(random() * 30)::int AS k,
           1 + floor(random() * 15)::int AS b,
           1 + floor(random() * 30)::int AS f1,
           1 + floor(random() * 30)::int AS f2,
           1 + floor(random() * 8)::int  AS u,
           chr(65 + floor(random() * 26)::int) || (100 + floor(random() * 9900)::int) AS model,
           random() AS r_price,
           random() AS r_stock,
           random() AS r_created
      FROM generate_series(1, 2000000) AS g(i)
)
INSERT INTO products (sku, name, description, category, brand, price, stock, tags, created_at, updated_at)
SELECT 'GEN-' || lpad(p.i::text, 7, '0'),
       w.adj[p.a] || ' ' || w.kind[p.k] || ' ' || p.model,
       CASE WHEN w.adj[p.a] ~ '^[AEIOU]' THEN 'An ' ELSE 'A ' END || lower(w.adj[p.a]) || ' ' || lower(w.kind[p.k]) || ' from ' || w.brand[p.b]
           || ' with ' || w.feature[p.f1] || ' and ' || w.feature[p.f2] || '. ' || w.audience[p.u],
       w.kind_category[p.k],
       w.brand[p.b],
       round((5 + p.r_price ^ 2 * 2995)::numeric, 2),
       CASE WHEN p.r_stock < 0.05 THEN 0 ELSE floor(p.r_stock * 200)::int END,
       ARRAY(SELECT DISTINCT unnest(ARRAY[w.kind_tag[p.k], w.feature_tag[p.f1], w.feature_tag[p.f2]])),
       p.updated_at - p.r_created * interval '3 years',
       p.updated_at
  FROM (SELECT *, now() - (2000000 - i) * interval '1 microsecond' AS updated_at FROM picks) p
 CROSS JOIN words w;

ANALYZE products;
