-- Seed initial users for testing (Lite, Pro, Flow+)
INSERT INTO users (id, telegram_id, username, first_name, last_name, role, status) VALUES
(1, 100000001, 'tester_lite', 'Alice', 'Lite', 'user', 'active'),
(2, 100000002, 'tester_pro', 'Bob', 'Pro', 'user', 'active'),
(3, 100000003, 'tester_flow', 'Charlie', 'Flow', 'user', 'active'),
(4, 999999999, 'sentra_admin', 'Admin', 'Root', 'admin', 'active');

-- Seed subscriptions with fixed tokens for mock API testing (with daily quota tracking)
INSERT INTO subscriptions (id, user_id, tier, token, status, upload_bytes, download_bytes, traffic_limit_bytes, speed_limit_bps, max_concurrent_devices, web_browsing_used_mb, download_used_mb, last_quota_reset, expires_at) VALUES
(1, 1, 'Sentra Lite', 'token_lite_sandbox_001', 'active', 52428800, 1048576000, 10737418240, 10485760, 1, 120, 450, datetime('now'), datetime('now', '+30 days')),
(2, 2, 'Sentra Pro', 'token_pro_sandbox_002', 'active', 1073741824, 21474836480, 161061273600, 104857600, 3, 0, 0, datetime('now'), datetime('now', '+90 days')),
(3, 3, 'Sentra Flow+', 'token_flow_sandbox_003', 'active', 5368709120, 107374182400, 1099511627776, 0, 10, 0, 0, datetime('now'), datetime('now', '+365 days'));

-- Seed local testing outbounds for the 4 Connection Modes
INSERT INTO outbounds (id, tag, protocol, server_address, server_port, network_transport, tls_enabled, min_tier, mode_category, country_code) VALUES
(1, 'Sentra Web Browsing', 'http', '127.0.0.1', 10801, 'httpupgrade', 0, 'Sentra Lite', 'web_browsing', 'DE'),
(2, 'Sentra Download', 'socks', '127.0.0.1', 10804, 'tcp', 0, 'Sentra Lite', 'download', 'FI'),
(3, 'Sentra Static IP US', 'vless', '127.0.0.1', 10802, 'tcp', 1, 'Sentra Pro', 'static_ip', 'US'),
(4, 'Sentra Gaming Node', 'socks', '127.0.0.1', 10803, 'quic', 0, 'Sentra Flow+', 'gaming', 'TR');

-- Seed support tickets
INSERT INTO support_tickets (id, ticket_number, user_id, subscription_id, category, subject, description, priority, status) VALUES
(1, 'TCK-2026-0001', 1, 1, 'connection', 'استعلام ترافیک روزانه وبگردی', 'آیا سهمیه ۲ گیگابایت وبگردی هر شب ساعت ۱۲ صفر می‌شود؟', 'low', 'open'),
(2, 'TCK-2026-0002', 3, 3, 'billing', 'درخواست فعال‌سازی IP مسکونی اختصاصی Gemini', 'درخواست اتصال به نود آی‌پی ثابت آمریکا جهت ترید در صرافی.', 'medium', 'in_progress');
