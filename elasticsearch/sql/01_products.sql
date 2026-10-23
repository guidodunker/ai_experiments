-- Sample product catalog for indexing into Elasticsearch.
-- updated_at is maintained by a trigger so incremental syncs can fetch only changed rows.
-- Re-running this script drops and recreates the table.

DROP TABLE IF EXISTS products;

CREATE TABLE products (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sku         TEXT           NOT NULL UNIQUE,
    name        TEXT           NOT NULL,
    description TEXT           NOT NULL,
    category    TEXT           NOT NULL,
    brand       TEXT           NOT NULL,
    price       NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
    stock       INTEGER        NOT NULL DEFAULT 0 CHECK (stock >= 0),
    tags        TEXT[]         NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ    NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ    NOT NULL DEFAULT now()
);

CREATE INDEX products_updated_at_idx ON products (updated_at);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER products_set_updated_at
    BEFORE UPDATE ON products
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO products (sku, name, description, category, brand, price, stock, tags) VALUES
('LAP-001', 'UltraBook Pro 14',        'Lightweight 14-inch laptop with an OLED display, 32 GB RAM and all-day battery life.',          'Laptops',     'Novatek',   1499.00,  12, '{laptop,oled,portable}'),
('LAP-002', 'WorkStation X17',         'Powerful 17-inch mobile workstation for 3D rendering, video editing and machine learning.',   'Laptops',     'Titan',     2899.00,   4, '{laptop,workstation,gpu}'),
('LAP-003', 'StudyBook 13',            'Affordable 13-inch laptop for students, with a comfortable keyboard and fast SSD.',           'Laptops',     'Novatek',    649.00,  35, '{laptop,budget,student}'),
('MON-001', 'ClearView 27 4K',         '27-inch 4K IPS monitor with USB-C power delivery and factory colour calibration.',            'Monitors',    'Lumina',     429.00,  20, '{monitor,4k,usb-c}'),
('MON-002', 'CurveMax 34',             '34-inch ultrawide curved gaming monitor with a 165 Hz refresh rate.',                         'Monitors',    'Titan',      599.00,   8, '{monitor,gaming,ultrawide}'),
('KEY-001', 'SilentType Mechanical',   'Quiet mechanical keyboard with hot-swappable switches and a German QWERTZ layout.',           'Accessories', 'Keyforge',   129.00,  50, '{keyboard,mechanical,qwertz}'),
('KEY-002', 'TravelKeys Slim',         'Foldable Bluetooth keyboard that pairs with up to three devices.',                            'Accessories', 'Keyforge',    59.90,  70, '{keyboard,bluetooth,portable}'),
('MOU-001', 'Precision Mouse M5',      'Ergonomic wireless mouse with a high-precision sensor and silent clicks.',                    'Accessories', 'Lumina',      49.90, 120, '{mouse,wireless,ergonomic}'),
('MOU-002', 'Vertical Comfort Mouse',  'Vertical mouse that reduces wrist strain during long working days.',                          'Accessories', 'Ergonix',     69.00,  40, '{mouse,ergonomic,vertical}'),
('HEA-001', 'QuietZone ANC',           'Over-ear headphones with active noise cancellation and 40 hours of playback.',                'Audio',       'Sonora',     279.00,  25, '{headphones,anc,wireless}'),
('HEA-002', 'OfficeTalk Headset',      'USB headset with a noise-cancelling boom microphone, certified for video calls.',             'Audio',       'Sonora',      89.00,  60, '{headset,microphone,usb}'),
('SPK-001', 'RoomFill Speaker',        'Compact smart speaker with rich bass and multi-room support.',                                'Audio',       'Sonora',     149.00,  18, '{speaker,smart,wireless}'),
('CAM-001', 'StreamCam 4K',            '4K webcam with autofocus and automatic low-light correction for streaming.',                  'Video',       'Lumina',     159.00,  30, '{webcam,4k,streaming}'),
('DOC-001', 'Thunder Dock 12-in-1',    'Docking station with dual display output, Ethernet and 100 W charging over a single cable.',  'Accessories', 'Novatek',    249.00,  15, '{dock,usb-c,thunderbolt}'),
('STO-001', 'FastDrive NVMe 2 TB',     'PCIe 5.0 NVMe SSD with read speeds of up to 12,000 MB/s.',                                    'Storage',     'Titan',      219.00,  45, '{ssd,nvme,storage}'),
('STO-002', 'Pocket SSD 1 TB',         'Rugged portable SSD, water- and dust-resistant, with USB-C.',                                 'Storage',     'Ergonix',    119.00,  55, '{ssd,portable,rugged}'),
('NET-001', 'MeshNet Wi-Fi 7 Kit',     'Wi-Fi 7 mesh system with three nodes that covers homes up to 500 square metres.',             'Networking',  'Novatek',    499.00,   9, '{wifi,mesh,router}'),
('NET-002', 'GigaSwitch 8',            'Unmanaged 8-port 2.5 Gigabit Ethernet switch with a silent, fanless design.',                 'Networking',  'Titan',       99.00,  33, '{switch,ethernet,fanless}'),
('CHA-001', 'ErgoChair Plus',          'Office chair with adjustable lumbar support, 4D armrests and a breathable mesh back.',        'Furniture',   'Ergonix',    449.00,   6, '{chair,ergonomic,office}'),
('DSK-001', 'LiftDesk Electric',       'Height-adjustable electric standing desk with memory presets and an anti-collision sensor.',  'Furniture',   'Ergonix',    599.00,   0, '{desk,standing,electric}');
