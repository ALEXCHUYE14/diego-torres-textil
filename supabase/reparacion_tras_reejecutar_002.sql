-- ============================================================================
--  DIEGO TORRES · Reparación tras volver a ejecutar migration_002
--  Usar SOLO si se ejecutó migration_002_cierre_mes_y_ajustes.sql sobre una
--  base que ya tenía aplicada la migración 007 (rol Administrador).
--  Segura de volver a ejecutar.
--
--  Qué deshace (migration_002 reinstaló sus versiones originales):
--   1. rpc_bloquear_periodo / rpc_desbloquear_periodo exigían rol
--      'operativo' → el Administrador no podía cerrar/abrir meses y el
--      Operativo sí. Se restauran las versiones de la migración 007.
--   2. Políticas RLS de periodos_bloqueados → vuelven a ser solo Administrador.
--   3. Funciones antiguas de un solo renglón rpc_registrar_entrada /
--      rpc_registrar_salida y fn_verificar_periodo_abierto(timestamptz):
--      se eliminan otra vez (migraciones 007 y 011). Permitían registrar
--      movimientos saltándose las validaciones de las versiones "_lote".
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_proc where proname = 'fn_es_administrador') then
    raise exception 'La migración 007 no está aplicada: no use este archivo. Siga ejecutando las migraciones pendientes en orden (la 007 ya corrige esto).';
  end if;
end $$;

-- 1. RPCs de cierre de mes · exclusivas de Administrador (migración 007)
create or replace function rpc_bloquear_periodo(p_anio_mes date, p_nota text default null)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mes date := date_trunc('month', p_anio_mes)::date;
begin
  if not fn_es_administrador() then
    raise exception 'Permiso denegado: se requiere rol Administrador';
  end if;

  insert into periodos_bloqueados (anio_mes, bloqueado_por, nota)
  values (v_mes, auth.uid(), p_nota)
  on conflict (anio_mes) do update set nota = excluded.nota;

  return json_build_object('anio_mes', v_mes, 'bloqueado', true);
end $$;

create or replace function rpc_desbloquear_periodo(p_anio_mes date)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_mes date := date_trunc('month', p_anio_mes)::date;
begin
  if not fn_es_administrador() then
    raise exception 'Permiso denegado: se requiere rol Administrador';
  end if;

  delete from periodos_bloqueados where anio_mes = v_mes;

  return json_build_object('anio_mes', v_mes, 'bloqueado', false);
end $$;

-- 2. RLS de periodos_bloqueados (migración 007)
drop policy if exists ins_periodos_bloqueados on periodos_bloqueados;
create policy ins_periodos_bloqueados on periodos_bloqueados
  for insert to authenticated with check (fn_es_administrador());
drop policy if exists del_periodos_bloqueados on periodos_bloqueados;
create policy del_periodos_bloqueados on periodos_bloqueados
  for delete to authenticated using (fn_es_administrador());

-- 3. Funciones antiguas reinstaladas por la 002 (migraciones 007 y 011)
drop function if exists rpc_registrar_entrada(uuid, text, numeric, numeric, uuid, text, text, text, date);
drop function if exists rpc_registrar_salida(uuid, text, numeric, uuid, text, text, text, uuid);
drop function if exists fn_verificar_periodo_abierto(timestamptz);

-- ============================================================================
-- Fin de la reparación.
-- ============================================================================
