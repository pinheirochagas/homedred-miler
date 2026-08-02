create or replace function public.media_uploads_are_enabled()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.media_events
    where id = 'homedred-2026'
      and uploads_enabled
  );
$$;

revoke all on function public.media_uploads_are_enabled() from public;
grant execute on function public.media_uploads_are_enabled() to authenticated;

drop policy if exists "Contributors can upload media files"
on storage.objects;

create policy "Contributors can upload media files"
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'media'
  and (storage.foldername(name))[1] = auth.uid()::text
  and public.media_uploads_are_enabled()
);

create policy "Contributors can read their own media files"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'media'
  and owner_id = auth.uid()::text
);
