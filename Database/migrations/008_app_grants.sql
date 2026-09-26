-- 008_app_grants.sql — Wave 5: least-privilege grants for the application role.
--
-- The migration Job runs as the schema OWNER (RDS master in EKS, chess_user in
-- compose/integration where it is superuser). The application runtime connects
-- as `chess_user` and needs rights on every object 001-007 created, plus
-- default privileges for objects future migrations create.
--
-- FAIL-CLOSED: every statement errors if role chess_user does not exist, which
-- aborts the migration visibly instead of shipping a silently broken schema.
-- Owner runbook (docs/security/wave5-baseline.md) creates the role BEFORE the
-- first ArgoCD sync. No FOR ROLE clause: default privileges attach to the
-- CURRENT (owner) role, which is correct in every environment.
-- Trigger functions are NOT security definer, so EXECUTE is granted too.

GRANT USAGE ON SCHEMA public TO chess_user;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO chess_user;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO chess_user;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO chess_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO chess_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON SEQUENCES TO chess_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO chess_user;
