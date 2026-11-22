-- Time zone of a proxy's exit location (from the IP-info check), e.g. "Europe/Madrid".
-- Shown as the local time in the top bar on proxied pages.
ALTER TABLE proxies ADD COLUMN exit_timezone TEXT;
