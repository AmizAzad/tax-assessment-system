-- Database bootstrap.
--
-- Plan reference: V2 section 13.1 -- four schemas in one database, for clarity
-- and grant separation. Flowable manages its own schema through its Liquibase
-- changelogs and we never write to it directly.

CREATE SCHEMA IF NOT EXISTS platform;
CREATE SCHEMA IF NOT EXISTS forms;
CREATE SCHEMA IF NOT EXISTS workflow;
CREATE SCHEMA IF NOT EXISTS tax;

-- Owned by Flowable, listed here so the engine can create it on first boot.
CREATE SCHEMA IF NOT EXISTS flowable;

-- Keycloak keeps its own tables out of the application schemas.
CREATE SCHEMA IF NOT EXISTS keycloak;

-- gen_random_uuid() for externally addressable entities.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Case-insensitive search on taxpayer name and case number without
-- functional indexes everywhere.
CREATE EXTENSION IF NOT EXISTS citext;

-- Lets an EXCLUDE constraint mix equality on plain columns with overlap on a
-- daterange. Used to stop two published rule sets covering the same
-- jurisdiction, tax type and date, which would make a liability depend on
-- which row a query happened to return first.
CREATE EXTENSION IF NOT EXISTS btree_gist;

COMMENT ON SCHEMA platform IS 'Identity, RBAC, masters, documents, notifications, audit, scheduling, i18n';
COMMENT ON SCHEMA forms    IS 'DynaForms: categories, templates, elements, submissions';
COMMENT ON SCHEMA workflow IS 'Process registry, snapshots, tasks, activity progress, SLA tracker';
COMMENT ON SCHEMA tax      IS 'Tax assessment domain and tax configuration';
