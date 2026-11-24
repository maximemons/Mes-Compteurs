import { initializeApp } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-app.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/11.0.0/firebase-auth.js";
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager
} from "https://www.gstatic.com/firebasejs/11.0.0/firebase-firestore.js";

// La clé "apiKey" d'une app web Firebase n'est pas un secret : elle identifie le projet.
// La protection des données repose sur les règles Firestore (voir firestore.rules).
export const firebaseConfig = {
  apiKey: "AIzaSyDdxAvwLrnmQX6ZDW_kuIN0plfHiJHofR4",
  authDomain: "mes-compteurs-b5881.firebaseapp.com",
  projectId: "mes-compteurs-b5881",
  storageBucket: "mes-compteurs-b5881.firebasestorage.app",
  messagingSenderId: "155529304410",
  appId: "1:155529304410:web:b30ab8913fe4da5907fb63"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

// Cache local persistant : les compteurs restent visibles même sans réseau.
export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: "select_account" });
