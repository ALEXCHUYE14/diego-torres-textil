import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ToastProvider } from './context/ToastContext';
import Layout from './components/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Entradas from './pages/Entradas';
import Salidas from './pages/Salidas';
import Articulos from './pages/Articulos';
import Kardex from './pages/Kardex';

function Rutas() {
  const { session, cargando } = useAuth();

  if (cargando) {
    return (
      <div className="grid min-h-screen place-items-center bg-pizarra-800">
        <div className="grid h-14 w-14 animate-pulse place-items-center rounded-2xl bg-white p-2">
          <img src="/img/logo.png" alt="Comercializadora T&E S.A.S." className="h-full w-full object-contain" />
        </div>
      </div>
    );
  }

  if (!session) return <Login />;

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/entradas" element={<Entradas />} />
        <Route path="/salidas" element={<Salidas />} />
        <Route path="/articulos" element={<Articulos />} />
        <Route path="/kardex" element={<Kardex />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Rutas />
      </AuthProvider>
    </ToastProvider>
  );
}
