-- 0002_column_grants: уточнение прав после аудита.
-- Проблемы 0001, которые закрывает эта миграция:
--   1) anon мог прочитать "calendarToken" из studios → утечка iCal-фида с данными клиентов
--   2) владелец мог UPDATE slug/status/token своей студии (по ТЗ slug меняет только админ платформы)
--   3) authenticated мог INSERT себе membership в ЧУЖУЮ студию (повышение прав)
--   4) запись в storage portfolio не проверяла, что владелец пишет в папку СВОЕЙ студии

-- 1) Анониму — только витринные колонки, без токена календаря
revoke select on studios from anon, authenticated;
grant select (id, slug, settings, status, "createdAt") on studios to anon;
grant select (id, slug, settings, status, "createdAt", "calendarToken") on studios to authenticated;

-- 2) Владелец меняет только settings; slug/status/calendarToken — только service role
revoke update on studios from anon, authenticated;
grant update (settings) on studios to authenticated;

-- 3) Членство: читаем/удаляем своё, но НЕ вставляем и не меняем роли (это делает админ платформы)
drop policy if exists "owner_all_memberships" on memberships;
create policy "member_read_own" on memberships for select using ("userId" = auth.uid());
create policy "member_del_own" on memberships for delete using ("userId" = auth.uid());
-- INSERT/UPDATE политик нет → для authenticated запрещено, service role обходит RLS

-- 4) Storage: владелец пишет только в папку своей студии (первый сегмент пути = studioId)
create or replace function user_owns_studio_folder(p_name text)
returns boolean language sql security definer set search_path = public, storage as $$
  select exists(
    select 1 from memberships m
    where m."userId" = auth.uid()
      and m."studioId" = (storage.foldername(p_name))[1]
  );
$$;

drop policy if exists "owner_write_portfolio_storage" on storage.objects;
create policy "owner_write_portfolio_storage" on storage.objects for insert
  with check (bucket_id = 'portfolio' and public.user_owns_studio_folder(name));
