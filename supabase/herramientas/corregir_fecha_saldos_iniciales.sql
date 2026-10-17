-- ============================================================================
--  DIEGO TORRES · Corregir la fecha de los saldos iniciales ya cargados
--  Ejecutar UNA vez en el SQL Editor de Supabase, DESPUÉS de actualizar_base.sql.
--  Es seguro volver a ejecutarlo: la segunda vez no encuentra filas que cambiar.
--
--  Qué hace: los saldos iniciales de la carga masiva quedaron con
--  fecha_registro = 01/03/2026 aunque se cargaron otro día. Se les pone como
--  fecha el día (hora de Colombia) en que realmente se registraron, que está
--  guardado en fecha_creacion.
--
--  Qué NO toca: cantidades, valores, costo promedio, stock, consecutivos,
--  ni ningún otro movimiento (entradas y salidas manuales quedan igual).
--
--  Si marzo de 2026 o el mes de destino está cerrado, no cambia nada y avisa:
--  reabra el mes desde Informe (Administrador) y vuelva a ejecutarlo.
-- ============================================================================

do $$
declare
  v_mes_cerrado text;
  v_filas integer;
begin
  select string_agg(distinct to_char(pb.anio_mes, 'MM/YYYY'), ', ')
  into v_mes_cerrado
  from historial_movimientos m
  join periodos_bloqueados pb
    on pb.anio_mes in (date '2026-03-01',
                       date_trunc('month', (m.fecha_creacion at time zone 'America/Bogota'))::date)
  where m.tipo_movimiento = '1007'
    and m.concepto = 'Saldo inicial · carga masiva de catálogo'
    and m.fecha_registro >= timestamptz '2026-03-01 00:00:00+00'
    and m.fecha_registro <  timestamptz '2026-03-02 00:00:00+00'
    and (m.fecha_creacion at time zone 'America/Bogota')::date > date '2026-03-01';

  if v_mes_cerrado is not null then
    raise exception 'No se cambió nada: el período % está cerrado. Reábralo desde Informe y vuelva a ejecutar este archivo.', v_mes_cerrado;
  end if;

  update historial_movimientos m
  set fecha_registro = make_timestamptz(
        extract(year  from (m.fecha_creacion at time zone 'America/Bogota'))::int,
        extract(month from (m.fecha_creacion at time zone 'America/Bogota'))::int,
        extract(day   from (m.fecha_creacion at time zone 'America/Bogota'))::int,
        0, 0, 0, 'UTC')
  where m.tipo_movimiento = '1007'
    and m.concepto = 'Saldo inicial · carga masiva de catálogo'
    and m.fecha_registro >= timestamptz '2026-03-01 00:00:00+00'
    and m.fecha_registro <  timestamptz '2026-03-02 00:00:00+00'
    and (m.fecha_creacion at time zone 'America/Bogota')::date > date '2026-03-01';

  get diagnostics v_filas = row_count;
  raise notice 'Saldos iniciales corregidos: %', v_filas;
end $$;

-- Verificación: saldos iniciales por fecha (ya no debería aparecer 2026-03-01).
select (fecha_registro at time zone 'UTC')::date as fecha_saldo_inicial, count(*) as movimientos
from historial_movimientos
where tipo_movimiento = '1007' and concepto = 'Saldo inicial · carga masiva de catálogo'
group by 1 order by 1;
