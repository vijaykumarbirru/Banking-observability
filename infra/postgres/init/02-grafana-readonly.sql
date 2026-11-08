-- Read-only login for Grafana's business dashboards. pg_read_all_data (PostgreSQL 14+)
-- grants SELECT on every table in every database, and nothing else.
CREATE ROLE grafana_ro WITH LOGIN PASSWORD 'grafana_ro_pw' IN ROLE pg_read_all_data;
