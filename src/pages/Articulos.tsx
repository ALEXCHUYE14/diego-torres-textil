import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Pencil, Plus, Power, PowerOff, Save, Trash2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { ConfirmModal, DataTable, PageHeader } from '../components/ui';
import ImportadorCatalogo from '../components/ImportadorCatalogo';
import { Color, Familia, Genero, Producto, Talla } from '../lib/types';
import { moneda, numero } from '../utils/format';

export default function Articulos() {
  const { toast } = useToast();
  const { esOperativo, esAdministrador } = useAuth();
  const nombreRef = useRef<HTMLInputElement>(null);
  const catalogoRef = useRef<HTMLDivElement>(null);

  const [familias, setFamilias] = useState<Familia[]>([]);
  const [generos, setGeneros] = useState<Genero[]>([]);
  const [colores, setColores] = useState<Color[]>([]);
  const [tallas, setTallas] = useState<Talla[]>([]);
  const [productos, setProductos] = useState<Producto[]>([]);
  const [idFamilia, setIdFamilia] = useState('');
  const [nombre, setNombre] = useState('');
  const [genero, setGenero] = useState('');
  const [color, setColor] = useState('');
  const [talla, setTalla] = useState('');
  const [editando, setEditando] = useState<Producto | null>(null);
  const [habilitado, setHabilitado] = useState(true);
  const [aEliminar, setAEliminar] = useState<Producto | null>(null);
  const [aCambiarEstado, setACambiarEstado] = useState<Producto | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [cambiandoEstado, setCambiandoEstado] = useState(false);
  const [destacadoId, setDestacadoId] = useState<string | null>(null);
  const [purgaAbierta, setPurgaAbierta] = useState(false);
  const [purgaTexto, setPurgaTexto] = useState('');
  const [purgando, setPurgando] = useState(false);

  const familia = familias.find((f) => f.id_familia === idFamilia) ?? null;

  // Composición dinámica en pantalla del código final: genero/color/talla son
  // opcionales, así que se omiten del código si el usuario los deja en blanco.
  const codigoPreview = useMemo(() => {
    const fam = familia ? familia.codigo : '·····';
    const cons = editando
      ? editando.codigo_barra.split('-')[1] ?? '···'
      : String((familia?.consecutivo_familia ?? 0) + 1).padStart(3, '0');
    const partes = [fam, cons, nombre.trim() ? nombre.trim().toUpperCase() : 'NOMBRE'];
    if (genero.trim()) partes.push(genero.trim().toUpperCase());
    if (color.trim()) partes.push(color.trim().toUpperCase());
    if (talla.trim()) partes.push(talla.trim().toUpperCase());
    return partes.join('-');
  }, [familia, nombre, genero, color, talla, editando]);

  const cargar = async () => {
    try {
      const [
        { data: f, error: e1 }, { data: p, error: e2 },
        { data: g, error: e3 }, { data: c, error: e4 }, { data: t, error: e5 },
      ] = await Promise.all([
        supabase.from('familias').select('*').order('codigo'),
        supabase.from('productos').select('*').order('activo', { ascending: false }).order('fecha_creacion', { ascending: false }),
        supabase.from('generos').select('*').order('nombre'),
        supabase.from('colores').select('*').order('nombre'),
        supabase.from('tallas').select('*').order('nombre'),
      ]);
      if (e1 || e2 || e3 || e4 || e5) { toast('error', 'No se pudo cargar el catálogo de artículos'); return; }
      setFamilias((f as Familia[]) ?? []);
      setProductos((p as Producto[]) ?? []);
      setGeneros((g as Genero[]) ?? []);
      setColores((c as Color[]) ?? []);
      setTallas((t as Talla[]) ?? []);
    } catch {
      toast('error', 'Error de red al cargar el catálogo. Verifique su conexión.');
    }
  };
  useEffect(() => { cargar(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // El resaltado del registro recién creado dura unos segundos y luego se apaga solo
  useEffect(() => {
    if (!destacadoId) return;
    const t = setTimeout(() => setDestacadoId(null), 4000);
    return () => clearTimeout(t);
  }, [destacadoId]);

  const agregar = () => {
    setEditando(null); setHabilitado(true);
    setIdFamilia(''); setNombre(''); setGenero(''); setColor(''); setTalla('');
    nombreRef.current?.focus();
  };

  const editar = (p: Producto) => {
    setEditando(p); setHabilitado(false);
    setIdFamilia(p.id_familia); setNombre(p.nombre);
    setGenero(p.genero ?? ''); setColor(p.color ?? ''); setTalla(p.talla ?? '');
    nombreRef.current?.focus();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const guardar = async () => {
    if (!idFamilia) { toast('aviso', 'Seleccione la familia del artículo'); return; }
    if (!nombre.trim()) { toast('aviso', 'El nombre del artículo es obligatorio'); return; }
    setGuardando(true);
    try {
      if (editando) {
        const { error } = await supabase
          .from('productos')
          .update({
            nombre: nombre.trim().toUpperCase(),
            genero: genero.trim() ? genero.trim().toUpperCase() : null,
            color: color.trim() ? color.trim().toUpperCase() : null,
            talla: talla.trim() ? talla.trim().toUpperCase() : null,
          })
          .eq('id_producto', editando.id_producto);
        if (error) {
          toast('error', error.code === '23505'
            ? 'Ya existe otro artículo activo con ese mismo nombre, género, color y talla en esta familia.'
            : error.message);
          return;
        }
        toast('exito', 'Artículo actualizado con éxito');
        agregar();
        await cargar();
      } else {
        const { data, error } = await supabase.rpc('rpc_crear_articulo', {
          p_id_familia: idFamilia,
          p_nombre: nombre,
          p_genero: genero.trim() || null,
          p_color: color.trim() || null,
          p_talla: talla.trim() || null,
        });
        if (error) { toast('error', error.message); return; }
        toast(data.ya_existia ? 'aviso' : 'exito', data.ya_existia
          ? `Ya existía un artículo idéntico · ${data.codigo_barra}`
          : `Artículo creado · ${data.codigo_barra}`);
        agregar();
        await cargar();
        // UX: deja claro dónde quedó guardado — resalta la fila y hace scroll al catálogo
        setDestacadoId(data.id_producto as string);
        catalogoRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    } catch {
      toast('error', 'Error de red al guardar el artículo. Verifique su conexión.');
    } finally {
      setGuardando(false);
    }
  };

  const eliminar = async () => {
    if (!aEliminar) return;
    try {
      const { error } = await supabase
        .from('productos')
        .update({ activo: false })
        .eq('id_producto', aEliminar.id_producto);
      if (error) { toast('error', error.message); return; }
      toast('exito', 'Código eliminado del catálogo');
      cargar();
    } catch {
      toast('error', 'Error de red al eliminar el código. Verifique su conexión.');
    } finally {
      setAEliminar(null);
    }
  };

  // A diferencia de "eliminar" (solo para artículos sin historial), esto
  // alterna activo/inactivo en artículos que YA tienen movimientos: no se
  // pueden borrar sin perder trazabilidad, pero sí se pueden dejar de
  // ofrecer para nuevas entradas/salidas. El kardex y los informes lo
  // siguen mostrando con normalidad; solo cambia si aparece como opción al
  // registrar movimientos nuevos.
  const cambiarEstado = async () => {
    if (!aCambiarEstado) return;
    setCambiandoEstado(true);
    try {
      const { error } = await supabase
        .from('productos')
        .update({ activo: !aCambiarEstado.activo })
        .eq('id_producto', aCambiarEstado.id_producto);
      if (error) {
        toast('error', error.code === '23505'
          ? 'No se puede activar: ya existe otro artículo activo con el mismo nombre, género, color y talla en esta familia.'
          : error.message);
        return;
      }
      toast('exito', aCambiarEstado.activo ? `${aCambiarEstado.nombre} desactivado` : `${aCambiarEstado.nombre} activado`);
      cargar();
    } catch {
      toast('error', 'Error de red al cambiar el estado del artículo. Verifique su conexión.');
    } finally {
      setCambiandoEstado(false);
      setACambiarEstado(null);
    }
  };

  // Reactivar es una acción de bajo riesgo (siempre reversible con
  // "Desactivar" de nuevo) — no necesita modal de confirmación.
  const reactivar = async (p: Producto) => {
    try {
      const { error } = await supabase.from('productos').update({ activo: true }).eq('id_producto', p.id_producto);
      if (error) {
        toast('error', error.code === '23505'
          ? 'No se puede activar: ya existe otro artículo activo con el mismo nombre, género, color y talla en esta familia.'
          : error.message);
        return;
      }
      toast('exito', `${p.nombre} activado`);
      cargar();
    } catch {
      toast('error', 'Error de red al activar el artículo. Verifique su conexión.');
    }
  };

  // Borrado total del catálogo (artículos + su historial de movimientos y
  // ventas). Exclusivo de Administrador, verificado también en el servidor
  // (rpc_purgar_catalogo). Requiere escribir "ELIMINAR" para habilitar el
  // botón de confirmación — es irreversible y de alto impacto, por eso no
  // basta con el modal de confirmación estándar de dos botones.
  const purgarCatalogo = async () => {
    setPurgando(true);
    try {
      const { data, error } = await supabase.rpc('rpc_purgar_catalogo');
      if (error) { toast('error', error.message); return; }
      toast('exito', `Catálogo eliminado: ${data.articulos_eliminados} artículo(s) y ${data.movimientos_eliminados} movimiento(s) borrados`);
      setPurgaAbierta(false);
      setPurgaTexto('');
      await cargar();
    } catch {
      toast('error', 'Error de red al eliminar el catálogo. Verifique su conexión.');
    } finally {
      setPurgando(false);
    }
  };

  return (
    <div>
      <PageHeader
        titulo="Codificación de artículos"
        subtitulo="El código se compone en vivo: Familia · Consecutivo · Nombre · (Género · Color · Talla si aplican)"
        extra={
          <div className="flex flex-wrap items-center gap-3">
            <ImportadorCatalogo familias={familias} deshabilitado={!esOperativo} onCompletado={cargar} />
            {esAdministrador && (
              <button
                className="dt-btn dt-btn-ghost !text-borgona-600 hover:!bg-borgona-50"
                disabled={productos.length === 0}
                onClick={() => setPurgaAbierta(true)}
              >
                <AlertTriangle size={16} /> Eliminar todo el catálogo
              </button>
            )}
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        {/* ---------- Formulario ---------- */}
        <div className="dt-card p-5 md:p-7">
          <div className="grid gap-5 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <label className="dt-label" htmlFor="familia">Familia *</label>
              <select id="familia" className="dt-input" value={idFamilia} disabled={!habilitado || !!editando || !esOperativo}
                onChange={(e) => setIdFamilia(e.target.value)}>
                <option value="" disabled>Seleccione la familia…</option>
                {familias.map((f) => (
                  <option key={f.id_familia} value={f.id_familia}>{f.codigo} — {f.nombre}</option>
                ))}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="dt-label" htmlFor="art-nombre">Nombre *</label>
              <input id="art-nombre" ref={nombreRef} className="dt-input uppercase" disabled={!habilitado || !esOperativo}
                value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="BATA · o EXTINTOR MARCA CHAFLUE" />
            </div>
            <div>
              <label className="dt-label" htmlFor="art-genero">Género <span className="font-normal normal-case text-pizarra-400">(opcional)</span></label>
              <select id="art-genero" className="dt-input" disabled={!habilitado || !esOperativo} value={genero} onChange={(e) => setGenero(e.target.value)}>
                <option value="">— No aplica —</option>
                {generos.map((g) => <option key={g.id_genero} value={g.nombre}>{g.nombre}</option>)}
              </select>
            </div>
            <div>
              <label className="dt-label" htmlFor="art-color">Color <span className="font-normal normal-case text-pizarra-400">(opcional)</span></label>
              <select id="art-color" className="dt-input" disabled={!habilitado || !esOperativo} value={color} onChange={(e) => setColor(e.target.value)}>
                <option value="">— No aplica —</option>
                {colores.map((c) => <option key={c.id_color} value={c.nombre}>{c.nombre}</option>)}
              </select>
            </div>
            <div>
              <label className="dt-label" htmlFor="art-talla">Talla <span className="font-normal normal-case text-pizarra-400">(opcional)</span></label>
              <select id="art-talla" className="dt-input" disabled={!habilitado || !esOperativo} value={talla} onChange={(e) => setTalla(e.target.value)}>
                <option value="">— No aplica —</option>
                {tallas.map((t) => <option key={t.id_talla} value={t.nombre}>{t.nombre}</option>)}
              </select>
            </div>
          </div>
          <p className="mt-3 text-[12px] text-pizarra-400">
            ¿Faltan opciones de género, color o talla? Adminístrelas desde <strong>Catálogos</strong>.
          </p>

          {/* Panel de acciones estándar */}
          <div className="costura my-6" />
          <div className="flex flex-wrap gap-3">
            <button className="dt-btn dt-btn-ghost" onClick={agregar}>
              <Plus size={17} /> Agregar
            </button>
            <button className="dt-btn dt-btn-ghost" disabled={!editando} onClick={() => setHabilitado(true)}>
              <Pencil size={16} /> Editar
            </button>
            {esAdministrador && editando && (
              !editando.activo ? (
                <button className="dt-btn dt-btn-ghost !text-emerald-600 hover:!bg-emerald-50" onClick={() => reactivar(editando)}>
                  <Power size={16} /> Activar
                </button>
              ) : editando.tiene_movimientos ? (
                <button className="dt-btn dt-btn-ghost !text-borgona-600 hover:!bg-borgona-50" onClick={() => setACambiarEstado(editando)}>
                  <PowerOff size={16} /> Desactivar
                </button>
              ) : (
                <button className="dt-btn dt-btn-ghost !text-borgona-600 hover:!bg-borgona-50" onClick={() => setAEliminar(editando)}>
                  <Trash2 size={16} /> Eliminar
                </button>
              )
            )}
            <button className="dt-btn dt-btn-primary ml-auto" onClick={guardar} disabled={guardando || !esOperativo || (!!editando && !habilitado)}>
              <Save size={17} /> {guardando ? 'Guardando…' : editando ? 'Guardar cambios' : 'Guardar'}
            </button>
          </div>
        </div>

        {/* ---------- Firma visual: etiqueta de prenda ---------- */}
        <aside className="etiqueta-prenda h-fit p-6 pt-9 lg:sticky lg:top-8">
          <p className="text-center text-[11px] font-semibold uppercase tracking-[0.24em] text-pizarra-400">
            Etiqueta · código textil
          </p>
          <p className="mt-4 break-all text-center font-mono text-[15px] font-bold leading-relaxed text-pizarra-800">
            {codigoPreview.split('-').map((parte, i, arr) => (
              <span key={i}>
                <span className={i === 0 ? 'text-indigo-600' : i === 1 ? 'text-borgona-600' : ''}>{parte}</span>
                {i < arr.length - 1 && <span className="text-pizarra-300">-</span>}
              </span>
            ))}
          </p>
          <div className="costura my-5" />
          <dl className="space-y-1.5 text-[12.5px] text-pizarra-500">
            <div className="flex justify-between"><dt>Familia</dt><dd className="font-medium text-pizarra-700">{familia ? familia.nombre : '—'}</dd></div>
            <div className="flex justify-between"><dt>Consecutivo</dt><dd className="font-mono text-pizarra-700">{editando ? 'asignado' : `próximo: ${String((familia?.consecutivo_familia ?? 0) + 1).padStart(3, '0')}`}</dd></div>
            <div className="flex justify-between"><dt>Modo</dt><dd className="font-medium text-pizarra-700">{editando ? 'Edición' : 'Creación'}</dd></div>
          </dl>
        </aside>
      </div>

      {/* ---------- Catálogo ---------- */}
      <div ref={catalogoRef} className="dt-card mt-6 scroll-mt-6 p-5 md:p-6">
        <h2 className="mb-4 text-[16px] font-bold text-pizarra-800">Catálogo de artículos</h2>
        <DataTable<Producto & Record<string, unknown>>
          columnas={[
            { clave: 'codigo_barra', titulo: 'Código', render: (p) => <span className="font-mono text-[12.5px] text-indigo-600">{p.codigo_barra}</span> },
            { clave: 'nombre', titulo: 'Artículo', render: (p) => [p.nombre, p.color, p.talla].filter(Boolean).join(' · ') },
            { clave: 'stock_real', titulo: 'Stock', numerica: true, render: (p) => numero(p.stock_real) },
            { clave: 'costo_promedio_ponderado', titulo: 'CPP', numerica: true, render: (p) => moneda(p.costo_promedio_ponderado) },
            { clave: 'activo', titulo: 'Estado', render: (p) => (
              <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${p.activo ? 'bg-emerald-50 text-emerald-600' : 'bg-pizarra-100 text-pizarra-500'}`}>
                {p.activo ? 'Activo' : 'Inactivo'}
              </span>
            )},
            { clave: 'id_producto', titulo: '', render: (p) => (
              <div className="flex justify-end gap-1.5">
                <button className="rounded-lg p-1.5 text-pizarra-400 hover:bg-indigo-600/10 hover:text-indigo-600 transition" onClick={() => editar(p)} aria-label={`Editar ${p.nombre}`}>
                  <Pencil size={15} />
                </button>
                {esAdministrador && (
                  !p.activo ? (
                    <button className="rounded-lg p-1.5 text-pizarra-400 hover:bg-emerald-50 hover:text-emerald-600 transition" onClick={() => reactivar(p)} aria-label={`Activar ${p.nombre}`}>
                      <Power size={15} />
                    </button>
                  ) : p.tiene_movimientos ? (
                    <button className="rounded-lg p-1.5 text-pizarra-400 hover:bg-borgona-50 hover:text-borgona-600 transition" onClick={() => setACambiarEstado(p)} aria-label={`Desactivar ${p.nombre}`}>
                      <PowerOff size={15} />
                    </button>
                  ) : (
                    <button className="rounded-lg p-1.5 text-pizarra-400 hover:bg-borgona-50 hover:text-borgona-600 transition" onClick={() => setAEliminar(p)} aria-label={`Eliminar ${p.nombre}`}>
                      <Trash2 size={15} />
                    </button>
                  )
                )}
              </div>
            )},
          ]}
          filas={productos as Array<Producto & Record<string, unknown>>}
          porPagina={8}
          vacio="Aún no hay artículos codificados"
          idDeFila={(p) => p.id_producto}
          resaltarId={destacadoId}
        />
      </div>

      <ConfirmModal
        abierto={aEliminar !== null}
        titulo="Eliminar código"
        mensaje={`¿Está seguro de que desea eliminar este código? ${aEliminar?.codigo_barra ?? ''} saldrá del catálogo. Como todavía no tiene movimientos registrados, no queda ningún historial asociado.`}
        onConfirmar={eliminar}
        onCancelar={() => setAEliminar(null)}
      />

      <ConfirmModal
        abierto={aCambiarEstado !== null}
        titulo="Desactivar artículo"
        mensaje={`¿Está seguro de que desea desactivar ${aCambiarEstado?.codigo_barra ?? ''}? Dejará de ofrecerse para nuevas entradas y salidas, pero su historial seguirá disponible en el kardex y en los informes. Puede volver a activarlo cuando lo necesite.`}
        onConfirmar={cambiarEstado}
        onCancelar={() => setACambiarEstado(null)}
        textoConfirmar={cambiandoEstado ? 'Desactivando…' : 'Desactivar'}
        deshabilitado={cambiandoEstado}
      />

      {/* Confirmación por texto: acción irreversible de alto impacto, no
          alcanza con el modal estándar de dos botones. */}
      {purgaAbierta && (
        <div
          className="fixed inset-0 z-[80] flex items-end md:items-center justify-center bg-pizarra-900/40 backdrop-blur-[2px] p-4 print:hidden"
          onClick={() => { if (!purgando) { setPurgaAbierta(false); setPurgaTexto(''); } }}
        >
          <div className="modal-enter dt-card w-full max-w-md p-6" role="alertdialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-borgona-50 text-borgona-600">
              <AlertTriangle size={22} />
            </div>
            <h3 className="text-center text-[17px] font-bold text-pizarra-800">Eliminar todo el catálogo</h3>
            <p className="mt-2 text-center text-[14px] leading-relaxed text-pizarra-500">
              Esto borra PERMANENTEMENTE los {productos.length} artículo(s) del catálogo junto con todo su historial de
              movimientos y ventas. Los consecutivos de Entradas, Salidas y Tickets vuelven a 0. No se puede deshacer.
            </p>
            <p className="mt-4 text-center text-[13px] font-semibold text-pizarra-700">
              Escriba <span className="font-mono text-borgona-600">ELIMINAR</span> para confirmar
            </p>
            <input
              className="dt-input mt-2 text-center uppercase"
              value={purgaTexto}
              onChange={(e) => setPurgaTexto(e.target.value)}
              disabled={purgando}
              autoFocus
              aria-label="Escriba ELIMINAR para confirmar"
            />
            <div className="mt-6 grid grid-cols-2 gap-3">
              <button
                className="dt-btn dt-btn-ghost"
                onClick={() => { setPurgaAbierta(false); setPurgaTexto(''); }}
                disabled={purgando}
              >
                Cancelar
              </button>
              <button
                className="dt-btn dt-btn-danger"
                onClick={purgarCatalogo}
                disabled={purgando || purgaTexto.trim().toUpperCase() !== 'ELIMINAR'}
              >
                {purgando ? 'Eliminando…' : 'Eliminar todo'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
