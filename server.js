import { createContext, useContext, useEffect, useState } from 'react';
import { auth } from '../services/firebase';

const ADMIN_EMAIL = 'celsogiodias@gmail.com';

const AuthContext = createContext({});

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged((firebaseUser) => {
      if (firebaseUser) {
        setUser({ ...firebaseUser, isAdmin: firebaseUser.email === ADMIN_EMAIL });
      } else {
        setUser(null);
      }
      setLoading(false);
    });

    // Renovação forçada do token a cada 30 min
    const intervalo = setInterval(async () => {
      try {
        if (auth.currentUser) {
          await auth.currentUser.getIdToken(true);
        }
      } catch (e) {
        // ignora falha na renovação
      }
    }, 30 * 60 * 1000);

    return () => {
      unsubscribe();
      clearInterval(intervalo);
    };
  }, []);

  const logout = async () => {
    try {
      await auth.signOut();
    } catch (error) {
      console.error("Erro ao sair:", error);
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, logout, auth }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
