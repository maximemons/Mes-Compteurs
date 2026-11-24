# Mes compteurs

Le temps qui passe, objectif par objectif : jours sans alcool, semaines depuis une naissance, années depuis un déménagement. Pensé pour le téléphone, installable comme une appli.

## Les compteurs

- Chaque compteur a un nom, une icône, une couleur et un **point de départ** (date et heure). Une date passée fonctionne aussi : une naissance, un mariage, un arrêt.
- **Afficher en** : heures, jours, semaines, mois, années, une ou plusieurs unités à la fois.
- **Présentation** :
  - **Chaque total** : chaque unité compte depuis le départ (ex. `1 353 jours · 193 semaines · 3 ans`) ;
  - **Décomposé** : les unités s’enchaînent (ex. `3 ans, 36 semaines, 5 jours`).
- Les mois et années suivent le calendrier (le 12 mars → le 12 avril = 1 mois), les jours tiennent compte des changements d’heure.
- Sur la page d’un compteur, les valeurs en grand et un chrono qui avance à la seconde (`+ 5 h 03 min 12 s`).
- Au premier lancement, trois modèles sont proposés : Sans alcool, Sans cigarette, Depuis une naissance.

## Catégories

- Les compteurs sont rangés par catégorie sur l’accueil ; ceux sans catégorie apparaissent dans « Sans catégorie ».
- **Glisser-déposer** pour changer un compteur de catégorie ou le réordonner :
  - à la souris : on attrape la carte et on la fait glisser ;
  - au doigt : **appui long** (environ 0,4 s) jusqu’à ce que la carte se soulève, puis on la fait glisser. La page défile toute seule près des bords.
- On peut aussi choisir la catégorie dans les réglages du compteur, ou en créer une nouvelle au passage.
- Bouton **Catégories** (en haut de l’accueil) : ajouter, renommer, changer la couleur, réordonner, supprimer. Supprimer une catégorie ne supprime aucun compteur : ils passent dans « Sans catégorie ».

## Remise à zéro

- Le bouton ↺ (sur la carte et sur la page du compteur) redémarre le compteur **au moment du clic**, après une **confirmation** qui rappelle la durée de la série en cours.
- L’option **Remise à zéro** peut être coupée pour les compteurs qui n’en ont pas besoin (une naissance, par exemple).

## Historique (optionnel)

- Désactivé par défaut. Il s’active dans les réglages du compteur ou directement depuis sa page.
- Chaque remise à zéro range la série arrêtée dans l’historique : dates, durée, barre comparée au record.
- En haut : série en cours, **record**, nombre de remises à zéro, et ce qu’il reste pour égaler le record.
- Une série peut être supprimée de l’historique.
- Désactiver l’historique masque les séries sans les effacer.

## Grands caps et notifications

Caps suivis : 7, 50, 100, 200, 300, 500, 1 000 et 1 500 jours, puis tous les 1 000 jours ; 1, 3 et 6 mois ; chaque anniversaire en années.

- Onglet **Prochains caps** : les 30 prochains caps de tous les compteurs, mois par mois.
- Sur l’accueil : le prochain cap toutes catégories confondues, et une pastille 🏆 sur les compteurs qui viennent d’en passer un (7 jours).
- Bouton **Activer les notifications** (onglet Prochains caps ou Mon compte) : une notification navigateur quand un compteur passe un cap. **Tester** affiche un aperçu.
- L’option **Notifier les grands caps** peut être coupée compteur par compteur.
- Un cap n’est notifié qu’une fois par appareil, et seulement s’il a été franchi il y a moins de 36 h (pas d’avalanche en activant les notifications ou en créant un compteur sur une date ancienne).
- Un appui sur la notification ouvre le compteur.

### Comment les notifications arrivent

Un navigateur ne peut pas réveiller une page fermée à une heure précise. Deux mécanismes se relaient, sans doublon :

1. **Appli ouverte ou en arrière-plan** : minuteur calé sur le prochain cap, et vérification à chaque retour sur l’appli.
2. **Synchronisation périodique** (Chrome/Android, appli installée) : le navigateur réveille le service worker de temps en temps ; il vérifie seul si un cap vient d’être passé. L’heure n’est pas garantie.

Sur iPhone, les notifications web demandent iOS 16.4 ou plus et l’appli ajoutée à l’écran d’accueil.

Pour une notification à l’heure exacte appli fermée, il faudrait un envoi côté serveur (Cloud Functions planifiée + Firebase Cloud Messaging, offre Blaze), comme dans Mes cadences.

## Compte

- Connexion avec Google. Chaque compte ne voit que ses propres compteurs (règles Firestore).
- Les données restent consultables hors connexion grâce au cache local de Firestore.

---

## Mise en route Firebase

1. **Authentication** › Méthodes de connexion : activer **Google**.
2. **Firestore Database** : créer la base (mode production).
3. Publier les règles de `firestore.rules` (console Firestore › Règles, ou `firebase deploy --only firestore:rules`).
4. **Authentication** › Paramètres › Domaines autorisés : ajouter le domaine d’hébergement s’il ne s’agit pas de `mes-compteurs-b5881.web.app` (ex. `monpseudo.github.io`).

### Héberger

Avec Firebase Hosting :

```
npm install -g firebase-tools
firebase login
firebase deploy
```

Le site est aussi compatible GitHub Pages (fichiers statiques, aucune compilation). Les notifications et le service worker demandent du HTTPS (ou `localhost`).

## Structure

```
index.html
css/style.css
js/firebase-config.js   configuration et initialisation Firebase
js/app.js               authentification, navigation, vues, glisser-déposer, éditeurs
js/counters-core.js     calcul des durées et des caps (commun appli / service worker)
js/notifications.js     notifications : autorisation, minuteur, liste transmise au service worker
sw.js                   service worker : synchronisation périodique, clic sur notification
firestore.rules         règles d’accès par compte
firebase.json           configuration Firebase Hosting
manifest.webmanifest    installation sur l’écran d’accueil
```

Données Firestore :

```
users/{uid}/categories/{id}  nom, couleur, ordre
users/{uid}/counters/{id}    nom, icône, couleur, catégorie, ordre, départ (startAt, ms),
                             unités, présentation, remise à zéro, historique, notifications,
                             séries passées (periods : [{ start, end }])
```
