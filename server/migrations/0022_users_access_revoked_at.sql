-- B-60: момент отзыва access-JWT. После сброса пароля requireAuth сравнивает
-- iat токена с access_revoked_at, чтобы старые токены гасли сразу, а не через 15 минут.
alter table users add column access_revoked_at timestamptz;