import { FormEvent, useEffect, useState } from 'react';
import { UserPlus } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { PageHeader } from '../components/ui';
import { etiquetaRol, ROLES_ASIGNABLES, Rol, Usuario } from '../lib/types';

export default function Usuarios() {
  const { toast } = useToast();
  const { session } = useAuth();
  const [usuarios, setUsuarios] = useState<Usuario[]>([]);
  const [cargandoLista, setCargandoLista] = useState(true);

  const [correo, setCorreo] = useState('');
  const [clave, setClave] = useState('');
  const [nombre, setNombre] = useState('');
  const [rol, setRol] = useState<Rol>('operativo');
  const [creando, setCreando] = useState(false);
  const [guardandoRolId, setGuardandoRolId] = useState<string | null>(null);

  const cargar = async () => {
    setCargandoLista(true);
    try {
      const { data, error } = await supabase.from('usuarios').select('*').order('nombre');
      if (error) { toast('error', 'No se pudo cargar la lista de usuarios'); return; }
      setUsuarios((data as Usuario[]) ?? []);
    } catch {
      toast('error', 'Error de red al cargar usuarios. Verifique su conexión.');
    } finally {
      setCargandoLista(false);
    }
  };
  useEffect(() => { cargar(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const limpiar = () => { setCorreo(''); setClave(''); setNombre(''); setRol('operativo'); };

  const crear = async (e: FormEvent) => {
    e.preventDefault();
    if (!correo.trim() || !clave || !nombre.trim()) {
      toast('aviso', 'Correo, contraseña y nombre son obligatorios');
      return;
    }
    if (clave.length < 8) { toast('error', 'La contraseña debe tener al menos 8 caracteres'); return; }
    setCreando(true);
    try {
      const { data, error } = await supabase.functions.invoke('crear-usuario', {
        body: { correo: correo.trim(), clave, nombre: nombre.trim(), rol },
      });
      if (error) {
        let mensaje = error.message || 'No se pudo crear el usuario';
        try {
          const cuerpo = await (error as { context?: Response }).context?.json?.();
          if (cuerpo?.error) mensaje = cuerpo.error;
        } catch { /* se conserva el mensaje genérico */ }
        toast('error', mensaje);
        return;
      }
      if (data?.error) { toast('error', data.error); return; }
      toast('exito', `Usuario ${correo.trim()} creado con rol ${etiquetaRol(rol)}`);
      limpiar();
      cargar();
    } catch {
      toast('error', 'Error de red al crear el usuario. Verifique su conexión — recuerde que la función crear-usuario debe estar desplegada en Supabase.');
    } finally {
      setCreando(false);
    }
  };

  const cambiarRol = async (u: Usuario, nuevoRol: Rol) => {
    setGuardandoRolId(u.id_usuario);
    try {
      const { error } = await supabase.from('usuarios').update({ rol: nuevoRol }).eq('id_usuario', u.id_usuario);
      if (error) { toast('error', error.message); return; }
      toast('exito', `Rol de ${u.nombre} actualizado a ${etiquetaRol(nuevoRol)}`);
      cargar();
    } catch {
      toast('error', 'Error de red al actualizar el rol. Verifique su conexión.');
    } finally {
      setGuardandoRolId(null);
    }
  };

  return (
    <div>
      <PageHeader titulo="Gestión de usuarios" subtitulo="Crear cuentas y asignar roles · exclusivo para Administrador" />

      <div className="grid gap-6 lg:grid-cols-[1fr_1.3fr]">
        {/* ---------- Alta de usuario ---------- */}
        <div className="dt-card p-5 md:p-6">
          <h2 className="mb-4 flex items-center gap-2 text-[16px] font-bold text-pizarra-800">
            <UserPlus size={18} className="text-indigo-600" /> Nuevo usuario
          </h2>
          <form onSubmit={crear} className="space-y-4">
            <div>
              <label className="dt-label" htmlFor="us-nombre">Nombre *</label>
              <input id="us-nombre" className="dt-input" value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Nombre completo" />
            </div>
            <div>
              <label className="dt-label" htmlFor="us-correo">Correo *</label>
              <input id="us-correo" type="email" className="dt-input" value={correo} onChange={(e) => setCorreo(e.target.value)} placeholder="usuario@diegotorres.pe" />
            </div>
            <div>
              <label className="dt-label" htmlFor="us-clave">Contraseña *</label>
              <input id="us-clave" type="password" className="dt-input" value={clave} onChange={(e) => setClave(e.target.value)} placeholder="Mínimo 8 caracteres" />
            </div>
            <div>
              <label className="dt-label" htmlFor="us-rol">Rol *</label>
              <select id="us-rol" className="dt-input" value={rol} onChange={(e) => setRol(e.target.value as Rol)}>
                {ROLES_ASIGNABLES.map((r) => <option key={r.valor} value={r.valor}>{r.etiqueta}</option>)}
              </select>
              <p className="mt-1.5 text-[11.5px] text-pizarra-400">
                Solo se puede asignar Operativo o Consulta desde aquí. Para nombrar otro Administrador, cambie el rol de un usuario ya creado en la lista de la derecha.
              </p>
            </div>
            <button type="submit" className="dt-btn dt-btn-primary w-full" disabled={creando}>
              {creando ? 'Creando…' : 'Crear usuario'}
            </button>
          </form>
        </div>

        {/* ---------- Lista + reasignación de rol ---------- */}
        <div className="dt-card p-5 md:p-6">
          <h2 className="mb-4 text-[16px] font-bold text-pizarra-800">Usuarios del sistema</h2>
          {cargandoLista ? (
            <p className="py-6 text-center text-[13.5px] text-pizarra-400">Cargando…</p>
          ) : usuarios.length === 0 ? (
            <p className="py-6 text-center text-[13.5px] text-pizarra-400">No hay usuarios</p>
          ) : (
            <ul className="divide-y divide-pizarra-100">
              {usuarios.map((u) => {
                const esUnoMismo = u.id_usuario === session?.user.id;
                return (
                  <li key={u.id_usuario} className="flex items-center justify-between gap-3 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-[14px] font-semibold text-pizarra-800">
                        {u.nombre} {esUnoMismo && <span className="text-[11px] font-normal text-pizarra-400">(usted)</span>}
                      </p>
                      <p className="truncate text-[12.5px] text-pizarra-500">{u.correo ?? '—'}</p>
                    </div>
                    <select
                      className="dt-input !w-auto shrink-0 !py-1.5 !text-[13px]"
                      value={u.rol}
                      disabled={guardandoRolId === u.id_usuario || esUnoMismo}
                      title={esUnoMismo ? 'No puede cambiar su propio rol desde aquí' : undefined}
                      onChange={(e) => cambiarRol(u, e.target.value as Rol)}
                    >
                      <option value="administrador">Administrador</option>
                      <option value="operativo">Operativo</option>
                      <option value="consulta">Consulta</option>
                    </select>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
