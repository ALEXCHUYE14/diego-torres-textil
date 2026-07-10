import { FormEvent, useEffect, useState } from 'react';
import { Boxes, Building2, Palette, Pencil, Plus, Ruler, Shirt, Trash2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { ConfirmModal, PageHeader } from '../components/ui';
import ImportadorProveedores from '../components/ImportadorProveedores';
import { Familia, Proveedor } from '../lib/types';

type Pestaña = 'proveedores' | 'familias' | 'colores' | 'tallas' | 'generos';

const PESTAÑAS: { clave: Pestaña; texto: string; icono: typeof Building2 }[] = [
  { clave: 'proveedores', texto: 'Proveedores', icono: Building2 },
  { clave: 'familias', texto: 'Familias', icono: Boxes },
  { clave: 'colores', texto: 'Colores', icono: Palette },
  { clave: 'tallas', texto: 'Tallas', icono: Ruler },
  { clave: 'generos', texto: 'Géneros', icono: Shirt },
];

/* ============================================================
   Lista simple (Colores / Tallas / Géneros): mismo formato
   {id, nombre, activo} en las tres tablas.
   ============================================================ */
interface FilaSimple { id: string; nombre: string; activo: boolean }

function ListaSimple({
  tabla, idCampo, titulo, placeholder,
}: {
  tabla: 'colores' | 'tallas' | 'generos';
  idCampo: 'id_color' | 'id_talla' | 'id_genero';
  titulo: string;
  placeholder: string;
}) {
  const { toast } = useToast();
  const { esOperativo } = useAuth();
  const [filas, setFilas] = useState<FilaSimple[]>([]);
  const [nuevo, setNuevo] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [aEliminar, setAEliminar] = useState<FilaSimple | null>(null);

  const cargar = async () => {
    try {
      const { data, error } = await supabase.from(tabla).select('*').order('nombre');
      if (error) { toast('error', `No se pudo cargar ${titulo.toLowerCase()}`); return; }
      setFilas(((data as Record<string, unknown>[]) ?? []).map((f) => ({
        id: f[idCampo] as string, nombre: f.nombre as string, activo: f.activo as boolean,
      })));
    } catch {
      toast('error', 'Error de red al cargar el catálogo. Verifique su conexión.');
    }
  };
  useEffect(() => { cargar(); }, [tabla]); // eslint-disable-line react-hooks/exhaustive-deps

  const agregar = async (e: FormEvent) => {
    e.preventDefault();
    const nombre = nuevo.trim().toUpperCase();
    if (!nombre) { toast('aviso', 'Escriba un nombre antes de agregar'); return; }
    setGuardando(true);
    try {
      const { error } = await supabase.from(tabla).insert({ nombre });
      if (error) {
        toast('error', error.code === '23505' ? `"${nombre}" ya existe en ${titulo.toLowerCase()}` : error.message);
        return;
      }
      toast('exito', `"${nombre}" agregado a ${titulo.toLowerCase()}`);
      setNuevo('');
      cargar();
    } catch {
      toast('error', 'Error de red al guardar. Verifique su conexión.');
    } finally {
      setGuardando(false);
    }
  };

  const eliminar = async () => {
    if (!aEliminar) return;
    try {
      const { error } = await supabase.from(tabla).delete().eq(idCampo, aEliminar.id);
      if (error) { toast('error', error.message); return; }
      toast('exito', `"${aEliminar.nombre}" eliminado`);
      cargar();
    } catch {
      toast('error', 'Error de red al eliminar. Verifique su conexión.');
    } finally {
      setAEliminar(null);
    }
  };

  return (
    <div className="dt-card p-5 md:p-6">
      <h2 className="mb-1 text-[16px] font-bold text-pizarra-800">{titulo}</h2>
      <p className="mb-4 text-[13px] text-pizarra-500">
        Estas opciones alimentan los selectores de Artículos. Puede agregar o quitar libremente.
      </p>

      {esOperativo && (
        <form onSubmit={agregar} className="mb-4 flex gap-2">
          <input
            className="dt-input uppercase"
            value={nuevo}
            onChange={(e) => setNuevo(e.target.value)}
            placeholder={placeholder}
          />
          <button type="submit" className="dt-btn dt-btn-primary shrink-0" disabled={guardando}>
            <Plus size={16} /> Agregar
          </button>
        </form>
      )}

      {filas.length === 0 ? (
        <p className="py-6 text-center text-[13.5px] text-pizarra-400">Aún no hay registros</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {filas.map((f) => (
            <li key={f.id} className="flex items-center gap-2 rounded-full border border-pizarra-200 bg-pizarra-50 px-3 py-1.5 text-[13px] font-medium text-pizarra-700">
              {f.nombre}
              {esOperativo && (
                <button
                  type="button"
                  onClick={() => setAEliminar(f)}
                  className="rounded-full p-0.5 text-pizarra-400 transition hover:bg-borgona-50 hover:text-borgona-600"
                  aria-label={`Eliminar ${f.nombre}`}
                >
                  <Trash2 size={13} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <ConfirmModal
        abierto={aEliminar !== null}
        titulo={`Eliminar "${aEliminar?.nombre ?? ''}"`}
        mensaje="Esta opción dejará de aparecer en los selectores de artículos nuevos. Los artículos que ya la usan no se modifican."
        onConfirmar={eliminar}
        onCancelar={() => setAEliminar(null)}
      />
    </div>
  );
}

/* ============================================================
   Gestión de Proveedores (CRUD completo)
   ============================================================ */
function GestionProveedores() {
  const { toast } = useToast();
  const { esOperativo } = useAuth();
  const [proveedores, setProveedores] = useState<Proveedor[]>([]);
  const [editando, setEditando] = useState<Proveedor | null>(null);
  const [nit, setNit] = useState('');
  const [razonSocial, setRazonSocial] = useState('');
  const [correo, setCorreo] = useState('');
  const [telefono, setTelefono] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [aEliminar, setAEliminar] = useState<Proveedor | null>(null);

  const cargar = async () => {
    try {
      const { data, error } = await supabase.from('terceros').select('*').order('razon_social');
      if (error) { toast('error', 'No se pudo cargar la lista de proveedores'); return; }
      setProveedores((data as Proveedor[]) ?? []);
    } catch {
      toast('error', 'Error de red al cargar proveedores. Verifique su conexión.');
    }
  };
  useEffect(() => { cargar(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const limpiar = () => {
    setEditando(null); setNit(''); setRazonSocial(''); setCorreo(''); setTelefono('');
  };

  const editar = (p: Proveedor) => {
    setEditando(p); setNit(p.nit_documento); setRazonSocial(p.razon_social);
    setCorreo(p.correo ?? ''); setTelefono(p.telefono ?? '');
  };

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    if (!nit.trim() || !razonSocial.trim()) { toast('aviso', 'NIT/documento y razón social son obligatorios'); return; }
    setGuardando(true);
    try {
      const payload = {
        nit_documento: nit.trim(), razon_social: razonSocial.trim().toUpperCase(),
        correo: correo.trim() || null, telefono: telefono.trim() || null,
      };
      const { error } = editando
        ? await supabase.from('terceros').update(payload).eq('id_proveedor', editando.id_proveedor)
        : await supabase.from('terceros').insert(payload);
      if (error) {
        toast('error', error.code === '23505' ? 'Ya existe un proveedor con ese NIT/documento' : error.message);
        return;
      }
      toast('exito', editando ? 'Proveedor actualizado' : 'Proveedor creado');
      limpiar();
      cargar();
    } catch {
      toast('error', 'Error de red al guardar el proveedor. Verifique su conexión.');
    } finally {
      setGuardando(false);
    }
  };

  const eliminar = async () => {
    if (!aEliminar) return;
    try {
      const { error } = await supabase.from('terceros').delete().eq('id_proveedor', aEliminar.id_proveedor);
      if (error) {
        toast('error', error.code === '23503'
          ? 'No se puede eliminar: este proveedor ya tiene movimientos registrados en el kardex.'
          : error.message);
        return;
      }
      toast('exito', 'Proveedor eliminado');
      cargar();
    } catch {
      toast('error', 'Error de red al eliminar. Verifique su conexión.');
    } finally {
      setAEliminar(null);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1.3fr]">
      <div className="dt-card p-5 md:p-6">
        <h2 className="mb-4 text-[16px] font-bold text-pizarra-800">{editando ? 'Editar proveedor' : 'Nuevo proveedor'}</h2>
        <form onSubmit={guardar} className="space-y-4">
          <div>
            <label className="dt-label" htmlFor="prov-nit">NIT / Documento *</label>
            <input id="prov-nit" className="dt-input font-mono" disabled={!esOperativo}
              value={nit} onChange={(e) => setNit(e.target.value)} placeholder="900123456-7" />
          </div>
          <div>
            <label className="dt-label" htmlFor="prov-razon">Razón social *</label>
            <input id="prov-razon" className="dt-input uppercase" disabled={!esOperativo}
              value={razonSocial} onChange={(e) => setRazonSocial(e.target.value)} placeholder="TEXTILES DEL NORTE S.A.S." />
          </div>
          <div>
            <label className="dt-label" htmlFor="prov-correo">Correo</label>
            <input id="prov-correo" type="email" className="dt-input" disabled={!esOperativo}
              value={correo} onChange={(e) => setCorreo(e.target.value)} placeholder="ventas@proveedor.com" />
          </div>
          <div>
            <label className="dt-label" htmlFor="prov-tel">Teléfono</label>
            <input id="prov-tel" className="dt-input" disabled={!esOperativo}
              value={telefono} onChange={(e) => setTelefono(e.target.value)} placeholder="300 123 4567" />
          </div>
          <div className="flex gap-3 pt-2">
            {editando && (
              <button type="button" className="dt-btn dt-btn-ghost" onClick={limpiar}>Cancelar</button>
            )}
            <button type="submit" className="dt-btn dt-btn-primary ml-auto" disabled={guardando || !esOperativo}>
              {guardando ? 'Guardando…' : editando ? 'Guardar cambios' : 'Crear proveedor'}
            </button>
          </div>
        </form>
      </div>

      <div className="dt-card p-5 md:p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[16px] font-bold text-pizarra-800">Proveedores registrados</h2>
          <ImportadorProveedores deshabilitado={!esOperativo} onCompletado={cargar} />
        </div>
        {proveedores.length === 0 ? (
          <p className="py-6 text-center text-[13.5px] text-pizarra-400">Aún no hay proveedores</p>
        ) : (
          <ul className="divide-y divide-pizarra-100">
            {proveedores.map((p) => (
              <li key={p.id_proveedor} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-semibold text-pizarra-800">{p.razon_social}</p>
                  <p className="truncate text-[12.5px] text-pizarra-500">{p.nit_documento} {p.telefono ? `· ${p.telefono}` : ''}</p>
                </div>
                {esOperativo && (
                  <div className="flex shrink-0 gap-1.5">
                    <button className="dt-btn dt-btn-ghost !px-3 !py-1.5" onClick={() => editar(p)}>Editar</button>
                    <button className="rounded-lg p-1.5 text-pizarra-400 hover:bg-borgona-50 hover:text-borgona-600 transition" onClick={() => setAEliminar(p)} aria-label={`Eliminar ${p.razon_social}`}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmModal
        abierto={aEliminar !== null}
        titulo="Eliminar proveedor"
        mensaje={`¿Está seguro de que desea eliminar a "${aEliminar?.razon_social ?? ''}"?`}
        onConfirmar={eliminar}
        onCancelar={() => setAEliminar(null)}
      />
    </div>
  );
}

/* ============================================================
   Gestión de Familias (CRUD completo) · código + nombre.
   El consecutivo de cada familia lo administra el sistema al
   crear artículos: aquí solo se muestra de referencia.
   ============================================================ */
function GestionFamilias() {
  const { toast } = useToast();
  const { esOperativo } = useAuth();
  const [familias, setFamilias] = useState<Familia[]>([]);
  const [editando, setEditando] = useState<Familia | null>(null);
  const [codigo, setCodigo] = useState('');
  const [nombre, setNombre] = useState('');
  const [guardando, setGuardando] = useState(false);
  const [aEliminar, setAEliminar] = useState<Familia | null>(null);

  const cargar = async () => {
    try {
      const { data, error } = await supabase.from('familias').select('*').order('codigo');
      if (error) { toast('error', 'No se pudo cargar la lista de familias'); return; }
      setFamilias((data as Familia[]) ?? []);
    } catch {
      toast('error', 'Error de red al cargar familias. Verifique su conexión.');
    }
  };
  useEffect(() => { cargar(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const limpiar = () => { setEditando(null); setCodigo(''); setNombre(''); };

  const editar = (f: Familia) => { setEditando(f); setCodigo(f.codigo); setNombre(f.nombre); };

  const guardar = async (e: FormEvent) => {
    e.preventDefault();
    if (!codigo.trim() || !nombre.trim()) { toast('aviso', 'Código y nombre son obligatorios'); return; }
    setGuardando(true);
    try {
      const payload = { codigo: codigo.trim(), nombre: nombre.trim().toUpperCase() };
      const { error } = editando
        ? await supabase.from('familias').update(payload).eq('id_familia', editando.id_familia)
        : await supabase.from('familias').insert({ ...payload, consecutivo_familia: 0 });
      if (error) {
        toast('error', error.code === '23505' ? `Ya existe una familia con el código "${codigo.trim()}"` : error.message);
        return;
      }
      toast('exito', editando ? 'Familia actualizada' : 'Familia creada');
      limpiar();
      cargar();
    } catch {
      toast('error', 'Error de red al guardar la familia. Verifique su conexión.');
    } finally {
      setGuardando(false);
    }
  };

  const eliminar = async () => {
    if (!aEliminar) return;
    try {
      const { error } = await supabase.from('familias').delete().eq('id_familia', aEliminar.id_familia);
      if (error) {
        toast('error', error.code === '23503'
          ? 'No se puede eliminar: ya hay artículos codificados en esta familia.'
          : error.message);
        return;
      }
      toast('exito', 'Familia eliminada');
      cargar();
    } catch {
      toast('error', 'Error de red al eliminar. Verifique su conexión.');
    } finally {
      setAEliminar(null);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
      <div className="dt-card p-5 md:p-6">
        <h2 className="mb-4 text-[16px] font-bold text-pizarra-800">{editando ? 'Editar familia' : 'Nueva familia'}</h2>
        <form onSubmit={guardar} className="space-y-4">
          <div>
            <label className="dt-label" htmlFor="fam-codigo">Código *</label>
            <input id="fam-codigo" className="dt-input font-mono" disabled={!esOperativo}
              value={codigo} onChange={(e) => setCodigo(e.target.value)} placeholder="21000" />
          </div>
          <div>
            <label className="dt-label" htmlFor="fam-nombre">Nombre *</label>
            <input id="fam-nombre" className="dt-input uppercase" disabled={!esOperativo}
              value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="ACCESORIOS" />
          </div>
          <div className="flex gap-3 pt-2">
            {editando && <button type="button" className="dt-btn dt-btn-ghost" onClick={limpiar}>Cancelar</button>}
            <button type="submit" className="dt-btn dt-btn-primary ml-auto" disabled={guardando || !esOperativo}>
              {guardando ? 'Guardando…' : editando ? 'Guardar cambios' : 'Crear familia'}
            </button>
          </div>
        </form>
      </div>

      <div className="dt-card p-5 md:p-6">
        <h2 className="mb-4 text-[16px] font-bold text-pizarra-800">Familias registradas</h2>
        {familias.length === 0 ? (
          <p className="py-6 text-center text-[13.5px] text-pizarra-400">Aún no hay familias</p>
        ) : (
          <ul className="divide-y divide-pizarra-100">
            {familias.map((f) => (
              <li key={f.id_familia} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-semibold text-pizarra-800">
                    <span className="font-mono text-indigo-600">{f.codigo}</span> — {f.nombre}
                  </p>
                  <p className="text-[12px] text-pizarra-400">Próximo consecutivo: {String(f.consecutivo_familia + 1).padStart(3, '0')}</p>
                </div>
                {esOperativo && (
                  <div className="flex shrink-0 gap-1.5">
                    <button className="rounded-lg p-1.5 text-pizarra-400 hover:bg-indigo-600/10 hover:text-indigo-600 transition" onClick={() => editar(f)} aria-label={`Editar ${f.nombre}`}>
                      <Pencil size={15} />
                    </button>
                    <button className="rounded-lg p-1.5 text-pizarra-400 hover:bg-borgona-50 hover:text-borgona-600 transition" onClick={() => setAEliminar(f)} aria-label={`Eliminar ${f.nombre}`}>
                      <Trash2 size={15} />
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <ConfirmModal
        abierto={aEliminar !== null}
        titulo="Eliminar familia"
        mensaje={`¿Está seguro de que desea eliminar "${aEliminar?.nombre ?? ''}"? Solo es posible si no tiene artículos codificados.`}
        onConfirmar={eliminar}
        onCancelar={() => setAEliminar(null)}
      />
    </div>
  );
}

/* ============================================================
   Página principal
   ============================================================ */
export default function Catalogos() {
  const [pestaña, setPestaña] = useState<Pestaña>('proveedores');

  return (
    <div>
      <PageHeader titulo="Catálogos" subtitulo="Proveedores, colores, tallas y géneros disponibles en el sistema" />

      <div className="mb-6 flex flex-wrap gap-2">
        {PESTAÑAS.map(({ clave, texto, icono: Icono }) => (
          <button
            key={clave}
            onClick={() => setPestaña(clave)}
            className={`dt-btn ${pestaña === clave ? 'dt-btn-primary' : 'dt-btn-ghost'}`}
          >
            <Icono size={16} /> {texto}
          </button>
        ))}
      </div>

      {pestaña === 'proveedores' && <GestionProveedores />}
      {pestaña === 'familias' && <GestionFamilias />}
      {pestaña === 'colores' && <ListaSimple tabla="colores" idCampo="id_color" titulo="Colores" placeholder="Ej. AZUL MARINO" />}
      {pestaña === 'tallas' && <ListaSimple tabla="tallas" idCampo="id_talla" titulo="Tallas" placeholder="Ej. XL" />}
      {pestaña === 'generos' && <ListaSimple tabla="generos" idCampo="id_genero" titulo="Géneros" placeholder="Ej. UNISEX" />}
    </div>
  );
}
