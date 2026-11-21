-- Seed initial users for testing (Lite, Pro, Flow+)
INSERT INTO users (id, telegram_id, username, first_name, last_name, role, status) VALUES
(1, 100000001, 'tester_lite', 'Alice', 'Lite', 'user', 'active'),
(2, 100000002, 'tester_pro', 'Bob', 'Pro', 'user', 'active'),
(3, 100000003, 'tester_flow', 'Charlie', 'Flow', 'user', 'active'),
(4, 999999999, 'sentra_admin', 'Admin', 'Root', 'admin', 'active');

-- Seed subscriptions with fixed tokens for mock API testing
INSERT INTO subscriptions (id, user_id, tier, token, status, upload_bytes, download_bytes, traffic_limit_bytes, speed_limit_bps, max_concurrent_devices, expires_at) VALUES
(1, 1, 'Sentra Lite', 'token_lite_sandbox_001', 'active', 52428800, 1048576000, 10737418240, 10485760, 1, datetime('now', '+30 days')),
(2, 2, 'Sentra Pro', 'token_pro_sandbox_002', 'active', 1073741824, 21474836480, 161061273600, 104857600, 3, datetime('now', '+90 days')),
(3, 3, 'Sentra Flow+', 'token_flow_sandbox_003', 'active', 5368709120, 107374182400, 1099511627776, 0, 10, datetime('now', '+365 days'));

-- Seed local testing outbounds pointing to localhost sandbox listeners (zero cost)
INSERT INTO outbounds (id, tag, protocol, server_address, server_port, network_transport, tls_enabled, min_tier, mode_category, country_code) VALUES
(1, 'Sentra Hydra', 'socks', '127.0.0.1', 10801, 'tcp', 0, 'Sentra Flow+', 'Hydra', 'US'),
(2, 'Sentra Shadow', 'socks', '127.0.0.1', 10802, 'tcp', 0, 'Sentra Pro', 'Shadow', 'DE'),
(3, 'Sentra Stealth', 'http', '127.0.0.1', 10803, 'tcp', 0, 'Sentra Flow+', 'Stealth', 'NL'),
(4, 'Sentra Pulse', 'socks', '127.0.0.1', 10804, 'tcp', 0, 'Sentra Lite', 'Pulse', 'SG');

-- Seed support tickets
INSERT INTO support_tickets (id, ticket_number, user_id, subscription_id, category, subject, description, priority, status) VALUES
(1, 'TCK-2026-0001', 1, 1, 'connection', 'Slow speed on Lite node', 'Latency reaches 400ms when connecting to Pulse Singapore in sandbox.', 'low', 'open'),
(2, 'TCK-2026-0002', 3, 3, 'billing', 'Upgrade to annual corporate flow', 'Requesting custom invoice for Flow+ enterprise deployment.', 'medium', 'in_progress');
