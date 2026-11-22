-- Exit IP of each upstream proxy (the address websites see) and where it is,
-- found by asking an IP-info service THROUGH the proxy (EXIT_IP_CHECK_URL,
-- default https://ipwho.is/). Shown in the floating toolbar on proxied pages.
ALTER TABLE proxies ADD COLUMN exit_ip TEXT;
ALTER TABLE proxies ADD COLUMN exit_country TEXT;          -- e.g. Spain
ALTER TABLE proxies ADD COLUMN exit_country_code TEXT;     -- e.g. ES
ALTER TABLE proxies ADD COLUMN exit_city TEXT;
ALTER TABLE proxies ADD COLUMN exit_isp TEXT;
ALTER TABLE proxies ADD COLUMN exit_ip_checked_at INTEGER;
ALTER TABLE proxy_checks ADD COLUMN exit_ip TEXT;

-- Per user: show the floating toolbar on proxied pages (1) or not (0).
ALTER TABLE users ADD COLUMN toolbar_enabled INTEGER NOT NULL DEFAULT 1;
