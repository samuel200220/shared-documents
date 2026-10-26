# Shared Docs Editor — Éditeur de Documents Partagé Collaboratif

> **Application d'édition collaborative de documents textuels en temps réel**, conçue pour une association, reposant sur une architecture AWS 100% serverless, sans serveurs applicatifs permanents, et strictement compatible avec l'offre gratuite AWS (**Free Tier = 0,00 $**).

---

## Sommaire

1. [Architecture et Choix Technologiques](#1-architecture-et-choix-technologiques)
2. [Instructions de Déploiement sur AWS](#2-instructions-de-déploiement-sur-aws)
3. [Instructions de Destruction des Ressources (Clean-up)](#3-instructions-de-destruction-des-ressources-clean-up)
4. [Instructions de Test et de Validation](#4-instructions-de-test-et-de-validation)
5. [Description Complète de l'API (Spécification pour le Jury)](#5-description-complète-de-lapi-spécification-pour-le-jury)
6. [Preuve du Coût du Projet (Free Tier AWS)](#6-preuve-du-coût-du-projet-free-tier-aws)
7. [Matrice de Conformité aux Exigences](#7-matrice-de-conformité-aux-exigences)

---

## 1. Architecture et Choix Technologiques

### 1.1 Vue d'ensemble

Le système adopte une architecture **Serverless modulaire** déployée dans une unique région AWS (**`eu-north-1`** - Stockholm). Il sépare strictement la persistance des métadonnées, le routage temps réel et la distribution de documents :

```
[Navigateurs Rédacteurs]   [Navigateurs Visiteurs]
          │ (React / Yjs)             │ (HTTP / GET PDF)
          ▼                           ▼
[Amazon API Gateway WebSocket]  [Amazon API Gateway HTTP]
          │                           │
          ▼                           ▼
[Lambda: WebSocketFunction]     [Lambda: ApiFunction]
          │                           │
          ├───────────────────────────┴───────────────────────────┐
          ▼                                                       ▼
[Amazon DynamoDB (Single-Table)]                       [Amazon S3 (Chiffré AES256)]
  • Métadonnées & Révisions Documents                    • Snapshots Yjs & Backups
  • Quotas Quotidiens (10k car.)                         • Fichiers PDF distribués
  • Compteurs Atomiques Téléchargements                           │
  • Sessions & Anti-Abus (TTL 60s)                                ▼
                                                       [Amazon SES (Notification e-mail)]
```

### 1.2 Justification des choix technologiques

| Composant | Technologie retenue | Justification & Avantages | Alternatives écartées |
| :--- | :--- | :--- | :--- |
| **Frontend** | **React 19 + TypeScript + Vite** | Typage statique strict, réactivité instantanée de l'UI, bundles ultra-rapides et compacts. | Vue/Angular (écosystème Yjs moins natif), JavaScript brut (manque de sûreté de typage). |
| **Moteur CRDT** | **Yjs** | Résolution mathématique des conflits sans autorité centrale, convergence garantie même lors d'éditions concurrentes au même index. | Operational Transformation (OT) : trop complexe à orchestrer sur une infrastructure serverless sans serveur d'état permanent. |
| **API Backend** | **AWS Lambda (Node.js 22 ARM64)** | Exécution serverless sans frais résiduels, passage à l'échelle instantané (concurrence automatique), architecture Graviton2 économique. | EC2 / ECS : coût fixe permanent, administration de serveurs et patching requis. |
| **Points d'entrée** | **Amazon API Gateway** (HTTP + WebSocket) | Prise en charge native du protocole WebSocket avec gestion d'état des connexions par ID, routage HTTP standard pour les requêtes REST. | Serveur WebSocket dédié (Node/Socket.io sur EC2) incompatible avec le modèle sans serveur. |
| **Base de données** | **Amazon DynamoDB** (Single-Table on-demand) | Latence de quelques millisecondes, support des **transactions atomiques** (`TransactWriteItems`) et écritures conditionnelles garantissant l'inviolabilité des quotas et limites. | RDS PostgreSQL / Aurora Serverless : coût minimal mensuel incompressible (hors Free Tier) et temps de démarrage à froid. |
| **Stockage d'objets**| **Amazon S3** (Buckets privés chiffrés) | Durabilité 99.999999999%, chiffrement AES256 par défaut, absence d'accès public direct garantissant le contrôle strict des téléchargements. | Stockage base de données : trop onéreux pour les blobs PDF et snapshots volumineux. |
| **Notifications** | **Amazon SES** | Envoi transactionnel immédiat d'un e-mail d'alerte au créateur dès l'épuisement du lien. | SNS / SQS : surdimensionné pour une notification individuelle au créateur. |
| **IaC** | **AWS SAM (Serverless Application Model)** | Déclaration déclarative de l'infrastructure, reproductibilité totale en une commande, intégration native avec CloudFormation. | Terraform (nécessite un backend d'état distant), CloudFormation natif (trop verbeux). |

---

## 2. Instructions de Déploiement sur AWS

### 2.1 Prérequis

1. **Node.js** : version 22.x LTS installée (`node --version`).
2. **AWS CLI** : version 2 configurée avec vos identifiants (`aws configure`).
3. **AWS SAM CLI** : version $\ge 1.100$ installée (`sam --version`).
4. **Région cible** : `eu-north-1` (obligatoire pour respecter la règle de mono-région).

### 2.2 Déploiement pas-à-pas

#### Étape 1 : Cloner le dépôt et compiler le backend
```bash
# 1. Cloner le projet
git clone <URL_DU_DEPOT>
cd shared-docs-editor

# 2. Installer les dépendances et valider le backend
cd backend/
npm ci
npm test          # Valider les 13 tests unitaires et de concurrence
npm run build:ts  # Compiler TypeScript vers dist/
cd ..
```

#### Étape 2 : Valider et compiler l'infrastructure SAM
```bash
# Valider la conformité du template SAM
sam validate --template-file infrastructure/template.yaml --lint

# Compiler les artifacts Lambda
sam build --template-file infrastructure/template.yaml
```

#### Étape 3 : Déployer sur AWS
```bash
# Déploiement guidé (première fois)
sam deploy --guided \
  --stack-name shared-docs-editor-prod \
  --region eu-north-1 \
  --capabilities CAPABILITY_IAM \
  --resolve-s3
```

Durant l'invite de commande interactive, acceptez les options par défaut :
- **Stack Name** : `shared-docs-editor-prod`
- **AWS Region** : `eu-north-1`
- **Parameter Environment** : `prod`
- **Allow SAM CLI to create IAM roles with the required permissions** : `Y`
- **Save arguments to configuration file (samconfig.toml)** : `Y`

#### Étape 4 : Noter les URLs de sortie (Outputs)
À la fin du déploiement, SAM affiche les sorties CloudFormation :
```text
Key                 Value
ApiEndpoint         https://xxxxxx.execute-api.eu-north-1.amazonaws.com
WebSocketEndpoint   wss://yyyyyy.execute-api.eu-north-1.amazonaws.com/prod
BucketName          shared-docs-editor-prod-documents-xxxxxx
```

#### Étape 5 : Configurer et démarrer le frontend
```bash
cd frontend/
npm ci

# Créer le fichier d'environnement avec les sorties de SAM
cat <<EOF > .env
VITE_API_URL=https://xxxxxx.execute-api.eu-north-1.amazonaws.com
VITE_WS_URL=wss://yyyyyy.execute-api.eu-north-1.amazonaws.com/prod
EOF

# Compiler pour la production
npm run build

# Lancer en local pour test immédiat
npm run dev
```
L'application est accessible localement à l'adresse `http://localhost:5173`.

---

## 3. Instructions de Destruction des Ressources (Clean-up)

Pour ne laisser aucune ressource active et garantir une dépense nulle (**0,00 $**) :

### Étape 1 : Vider le bucket S3
AWS CloudFormation refuse de supprimer un bucket S3 non vide. Il convient de vider les objets au préalable :
```bash
# Récupérer le nom du bucket créé
BUCKET_NAME=$(aws cloudformation describe-stacks \
  --stack-name shared-docs-editor-prod \
  --region eu-north-1 \
  --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue" \
  --output text)

# Vider tous les fichiers du bucket
aws s3 rm "s3://${BUCKET_NAME}" --recursive --region eu-north-1
```

### Étape 2 : Supprimer la pile CloudFormation avec SAM
```bash
sam delete \
  --stack-name shared-docs-editor-prod \
  --region eu-north-1 \
  --no-prompts
```

### Étape 3 : Vérifier la suppression complète
```bash
aws cloudformation describe-stacks \
  --stack-name shared-docs-editor-prod \
  --region eu-north-1
# Doit renvoyer : "Stack with id shared-docs-editor-prod does not exist"
```
Toutes les fonctions Lambda, tables DynamoDB, routes API Gateway et groupes de logs CloudWatch sont alors définitivement supprimés.

---

## 4. Instructions de Test et de Validation

### 4.1 Exécution des tests automatisés

```bash
cd backend/
npm test
```
**Résultats attendus :**
- `13 pass`, `0 fail`, durée $< 1\text{ seconde}$.
- Les tests démontrent mathématiquement et logiquement :
  1. L'inviolabilité de la limite de téléchargement sous requêtes concurrentes (`tests/download-reservation.test.ts`).
  2. La convergence sans perte de données de Yjs pour les éditions simultanées (`tests/collaboration.test.ts`).
  3. L'application stricte du quota d'écriture de 10 000 caractères et la détection d'abus (`tests/quota.test.ts`, `tests/abuse.test.ts`).
  4. La génération de PDF valides sans régression (`tests/pdf.test.ts`).

### 4.2 Test de l'API déployée via `curl`

#### 1. Vérification de santé (Healthcheck)
```bash
curl -i https://<API_URL>/health
# Réponse attendue : HTTP/1.1 200 OK {"status":"ok","timestamp":...}
```

#### 2. Création d'une session rédacteur
```bash
curl -i -X POST https://<API_URL>/sessions \
  -H "Content-Type: application/json" \
  -d '{"name":"Alice Dupont","email":"alice@example.com"}'

# Réponse attendue : HTTP/1.1 201 Created
# {"token":"...","user":{"id":"...","name":"Alice Dupont","email":"alice@example.com"}}
```

#### 3. Création d'un document
```bash
curl -i -X POST https://<API_URL>/documents \
  -H "Content-Type: application/json" \
  -H "X-Session-Token: <TOKEN>" \
  -d '{"title":"Projet Annuel","content":"Texte initial du document"}'
```

#### 4. Création d'un lien de téléchargement limité à 2 exemplaires
```bash
curl -i -X POST https://<API_URL>/documents/<DOC_ID>/download-links \
  -H "Content-Type: application/json" \
  -H "X-Session-Token: <TOKEN>" \
  -d '{"maxDownloads": 2}'

# Réponse : {"linkId":"...","token":"<DOWNLOAD_TOKEN>","url":"https://.../download/<DOWNLOAD_TOKEN>"}
```

#### 5. Test de la limite de téléchargement
```bash
# 1er téléchargement -> HTTP 200 (PDF binaire)
curl -i https://<API_URL>/download/<DOWNLOAD_TOKEN> --output doc1.pdf

# 2ème téléchargement (dernier exemplaire) -> HTTP 200 (PDF binaire) + Déclenchement email SES
curl -i https://<API_URL>/download/<DOWNLOAD_TOKEN> --output doc2.pdf

# 3ème téléchargement (au-delà de la limite) -> HTTP 410 Gone
curl -i https://<API_URL>/download/<DOWNLOAD_TOKEN>
# Réponse : HTTP/1.1 410 Gone {"error":"DOWNLOAD_LIMIT_EXHAUSTED","message":"Ce lien de téléchargement a expiré ou atteint sa limite."}
```

---

## 5. Description Complète de l'API (Spécification pour le Jury)

Toutes les routes de gestion exigent l'en-tête HTTP :  
`X-Session-Token: <token_obtenu_a_la_connexion>` (sauf `/sessions`, `/health` et `/download/{token}`).

### 5.1 Endpoints HTTP REST

#### `GET /health`
- **Description** : Sonde de disponibilité du service.
- **Requête** : Aucune donnée.
- **Réponse HTTP 200** :
  ```json
  {
    "status": "ok",
    "timestamp": 1729900000000
  }
  ```

---

#### `POST /sessions`
- **Description** : Identification d'un rédacteur (sans mot de passe).
- **Requête** :
  ```json
  {
    "name": "Alice Rédactrice",
    "email": "alice@association.org"
  }
  ```
- **Réponse HTTP 201** :
  ```json
  {
    "token": "sess_9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c",
    "user": {
      "id": "usr_c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f",
      "name": "Alice Rédactrice",
      "email": "alice@association.org",
      "dailyQuota": 10000,
      "quotaUsed": 0,
      "quotaRemaining": 10000
    }
  }
  ```
- **Codes d'erreur** : `400 Bad Request` (nom ou e-mail manquant ou invalide).

---

#### `GET /sessions/me`
- **Description** : Récupère l'état courant du profil et le solde exact du quota journalier d'écriture.
- **En-têtes** : `X-Session-Token: <token>`
- **Réponse HTTP 200** :
  ```json
  {
    "user": {
      "id": "usr_c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f",
      "name": "Alice Rédactrice",
      "email": "alice@association.org",
      "dailyQuota": 10000,
      "quotaUsed": 450,
      "quotaRemaining": 9550
    }
  }
  ```
- **Codes d'erreur** : `401 Unauthorized` (token expiré ou absent).

---

#### `GET /documents`
- **Description** : Liste l'ensemble des documents créés par ou partagés avec le rédacteur.
- **En-têtes** : `X-Session-Token: <token>`
- **Réponse HTTP 200** :
  ```json
  {
    "documents": [
      {
        "id": "doc_123e4567-e89b-12d3-a456-426614174000",
        "title": "Compte Rendu Assemblée Générale",
        "ownerId": "usr_c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f",
        "role": "owner",
        "revision": 3,
        "createdAt": 1729890000000,
        "updatedAt": 1729895000000
      }
    ]
  }
  ```

---

#### `POST /documents`
- **Description** : Crée un nouveau document textuel.
- **En-têtes** : `X-Session-Token: <token>`
- **Requête** :
  ```json
  {
    "title": "Rapport Financier 2026",
    "content": "Contenu initial optionnel..."
  }
  ```
- **Réponse HTTP 201** :
  ```json
  {
    "document": {
      "id": "doc_a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
      "title": "Rapport Financier 2026",
      "ownerId": "usr_c3d4e5f6-a7b8-4c9d-0e1f-2a3b4c5d6e7f",
      "content": "Contenu initial optionnel...",
      "revision": 1,
      "createdAt": 1729900000000,
      "updatedAt": 1729900000000
    }
  }
  ```

---

#### `GET /documents/{documentId}`
- **Description** : Récupère le contenu complet, la révision actuelle et les permissions d'un document.
- **En-têtes** : `X-Session-Token: <token>`
- **Réponse HTTP 200** :
  ```json
  {
    "document": {
      "id": "doc_a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d",
      "title": "Rapport Financier 2026",
      "content": "Dernière version acceptée du texte...",
      "revision": 4,
      "role": "owner",
      "sharedWith": [
        { "email": "bob@association.org", "role": "editor" }
      ]
    }
  }
  ```
- **Codes d'erreur** : `403 Forbidden` (accès non accordé), `404 Not Found`.

---

#### `PUT /documents/{documentId}`
- **Description** : Sauvegarde manuelle ou snapshot du document. Décompte atomiquement le quota pour les caractères insérés.
- **En-têtes** : `X-Session-Token: <token>`
- **Requête** :
  ```json
  {
    "content": "Nouveau contenu complet du document...",
    "expectedRevision": 4
  }
  ```
- **Réponse HTTP 200** :
  ```json
  {
    "success": true,
    "newRevision": 5,
    "charsCharged": 42,
    "quotaRemaining": 9508
  }
  ```
- **Codes d'erreur** :
  - `409 Conflict` : `expectedRevision` obsolète (mise à jour concurrente détectée).
  - `429 Too Many Requests` : `QUOTA_EXHAUSTED` (solde insuffisant pour cette insertion).
  - `429 Too Many Requests` : `RATE_LIMIT_BLOCKED` (comportement abusif $> 120\text{ ops/min}$).

---

#### `POST /documents/{documentId}/share`
- **Description** : Partage le document avec un autre rédacteur (rôle `editor` ou `reader`).
- **En-têtes** : `X-Session-Token: <token>`
- **Requête** :
  ```json
  {
    "email": "partenaire@association.org",
    "role": "editor"
  }
  ```
- **Réponse HTTP 200** :
  ```json
  {
    "success": true,
    "sharedWith": "partenaire@association.org",
    "role": "editor"
  }
  ```

---

#### `POST /documents/{documentId}/download-links`
- **Description** : Génère un lien de téléchargement PDF limité à un nombre maximal d'exemplaires.
- **En-têtes** : `X-Session-Token: <token>`
- **Requête** :
  ```json
  {
    "maxDownloads": 5
  }
  ```
- **Réponse HTTP 201** :
  ```json
  {
    "linkId": "lnk_7f8e9d0a-1b2c-3d4e-5f6a-7b8c9d0e1f2a",
    "token": "dwn_0123456789abcdef0123456789abcdef",
    "maxDownloads": 5,
    "downloadCount": 0,
    "remaining": 5,
    "url": "https://<API_URL>/download/dwn_0123456789abcdef0123456789abcdef",
    "status": "active"
  }
  ```

---

#### `GET /documents/{documentId}/download-links`
- **Description** : Liste les liens de téléchargement associés au document avec leur consommation en temps réel.
- **En-têtes** : `X-Session-Token: <token>`
- **Réponse HTTP 200** :
  ```json
  {
    "links": [
      {
        "linkId": "lnk_7f8e9d0a-1b2c-3d4e-5f6a-7b8c9d0e1f2a",
        "token": "dwn_0123456789abcdef0123456789abcdef",
        "maxDownloads": 5,
        "downloadCount": 5,
        "remaining": 0,
        "status": "exhausted",
        "url": "https://<API_URL>/download/dwn_0123456789abcdef0123456789abcdef",
        "createdAt": 1729900000000
      }
    ]
  }
  ```

---

#### `GET /documents/{documentId}/versions`
- **Description** : Liste l'historique des versions conservées du document.
- **En-têtes** : `X-Session-Token: <token>`
- **Réponse HTTP 200** :
  ```json
  {
    "versions": [
      {
        "versionId": "v_1",
        "revision": 1,
        "createdAt": 1729890000000,
        "author": "Alice"
      },
      {
        "versionId": "v_2",
        "revision": 2,
        "createdAt": 1729895000000,
        "author": "Bob"
      }
    ]
  }
  ```

---

#### `POST /documents/{documentId}/restore`
- **Description** : Restaure le document à une version antérieure spécifiée.
- **En-têtes** : `X-Session-Token: <token>`
- **Requête** :
  ```json
  {
    "versionId": "v_1"
  }
  ```
- **Réponse HTTP 200** :
  ```json
  {
    "success": true,
    "restoredRevision": 6,
    "content": "Contenu restauré..."
  }
  ```

---

#### `GET /download/{token}`
- **Description** : Téléchargement public du document au format PDF. Décrémente atomiquement le compteur restant.
- **Paramètre de requête optionnel** : `?check=1` (interroge l'état du lien sans consommer d'exemplaire).
- **Réponse HTTP 200 (Mode standard)** :
  - **Headers** :  
    `Content-Type: application/pdf`  
    `Content-Disposition: attachment; filename="document.pdf"`
  - **Body** : Flux binaire du document PDF généré à l'instant exact $T_1$.
- **Réponse HTTP 200 (Mode `?check=1`)** :
  ```json
  {
    "status": "active",
    "remaining": 2,
    "maxDownloads": 5,
    "title": "Compte Rendu Assemblée Générale"
  }
  ```
- **Réponse HTTP 410 Gone (Lien épuisé)** :
  ```json
  {
    "error": "DOWNLOAD_LIMIT_EXHAUSTED",
    "message": "Ce lien de téléchargement a expiré ou atteint sa limite maximale."
  }
  ```
- **Réponse HTTP 404 Not Found** :
  ```json
  {
    "error": "NOT_FOUND",
    "message": "Lien de téléchargement inexistant ou invalide."
  }
  ```

---

#### `GET /admin/stats`
- **Description** : Tableau de bord de l'association (documents ouverts, liens actifs, usagers bloqués).
- **Réponse HTTP 200** :
  ```json
  {
    "activeConnections": 12,
    "openDocuments": 4,
    "activeLinks": 3,
    "exhaustedLinks": 8,
    "totalDownloadsDistributed": 45,
    "blockedUsersCount": 0,
    "blockedUsers": []
  }
  ```

---

### 5.2 Spécification du Protocole Temps Réel (WebSocket)

- **URL de connexion** :
  ```text
  wss://<WEBSOCKET_ENDPOINT>?documentId=<DOC_ID>&userId=<USER_ID>&token=<SESSION_TOKEN>
  ```

#### Messages émis par le Client vers le Serveur :

1. **Initialisation de la synchronisation Yjs (`sync-step-1`)** :
   ```json
   {
     "action": "sync-step-1"
   }
   ```
2. **Diffusion d'une modification Yjs (`update`)** :
   ```json
   {
     "action": "update",
     "updateId": "upd_1729900000000_a1b2",
     "epoch": 1,
     "update": "<base64_encoded_yjs_binary_delta>"
   }
   ```
3. **Diffusion de la position du curseur (`cursor`)** :
   ```json
   {
     "action": "cursor",
     "position": 142,
     "line": 4,
     "col": 12
   }
   ```

#### Messages reçus par le Client depuis le Serveur :

1. **Confirmation de connexion (`connected`)** :
   ```json
   {
     "type": "connected",
     "connectionId": "conn_xyz123",
     "writersCount": 3
   }
   ```
2. **Morceau de snapshot d'état Yjs initial (`binary-part`)** :
   ```json
   {
     "type": "binary-part",
     "data": "<base64_part_data>",
     "part": 1,
     "total": 1
   }
   ```
3. **Mise à jour concurrente d'un autre rédacteur (`update`)** :
   ```json
   {
     "type": "update",
     "update": "<base64_encoded_yjs_binary_delta>",
     "sender": "usr_bob"
   }
   ```
4. **Mouvement de curseur d'un collaborateur (`cursor`)** :
   ```json
   {
     "type": "cursor",
     "userId": "usr_bob",
     "displayName": "Bob Martin",
     "position": 150,
     "line": 4,
     "col": 20
   }
   ```
5. **Arrivée / Départ d'un rédacteur (`user-joined` / `user-left`)** :
   ```json
   { "type": "user-joined", "userId": "usr_bob", "displayName": "Bob Martin" }
   { "type": "user-left", "userId": "usr_bob" }
   ```
6. **Alerte de dépassement de quota (`quota-exceeded`)** :
   ```json
   {
     "type": "quota-exceeded",
     "remaining": 0,
     "message": "Quota quotidien de 10 000 caractères atteint."
   }
   ```

---

## 6. Preuve du Coût du Projet (Free Tier AWS)

Le sujet exige la preuve formelle que l'architecture s'exécute dans les limites de l'offre gratuite AWS (**Free Tier**), sans générer aucun coût (**0,00 $**) :

### 6.1 Tableau d'éligibilité et de consommation

| Service AWS | Quota mensuel Free Tier | Utilisation pour les tests & qualification | Coût facturé |
| :--- | :--- | :--- | :--- |
| **AWS Lambda** | 1 000 000 requêtes / mois + 3,2M secondes de calcul | $\approx 25\,000$ requêtes (tests et charge locale) | **0,00 $** |
| **Amazon DynamoDB** | **25 Go** de stockage + 25 WCU / 25 RCU permanents | $< 50\text{ Mo}$ de données (métadonnées et liens) | **0,00 $** |
| **Amazon S3** | **5 Go** en classe Standard + 20 000 requêtes GET / 2 000 PUT | $< 20\text{ Mo}$ de stockage (PDFs et snapshots Yjs) | **0,00 $** |
| **Amazon API Gateway**| 1 000 000 requêtes HTTP / mois (12 premiers mois) | $\approx 20\,000$ requêtes | **0,00 $** |
| **Amazon CloudWatch** | 10 métriques personnalisées + 5 Go de journaux d'ingestion | $< 100\text{ Mo}$ de journaux Lambda | **0,00 $** |
| **Amazon SES** | 62 000 emails / mois sortants (si émis depuis Lambda) | $< 50$ notifications de test | **0,00 $** |
| **Total Global** | — | — | **0,00 $** |

### 6.2 Justification de l'absence de coût résiduel
- **Aucun serveur d'état permanent** : Aucune instance EC2, aucun cluster ECS, aucune base de données relationnelle provisionnée (pas de frais fixes de 15-20 $/mois).
- **Région `eu-north-1`** : Tarification standard européenne avec support complet du Free Tier sur tous les services exploités.
- **Nettoyage automatique via TTL** : Les clés temporaires de limitation d'abus (`ABUSE#...`) et de présence WebSocket (`CONNECTION#...`) sont automatiquement purgées par le mécanisme DynamoDB Time-To-Live sans frais d'écriture.

---

## 7. Matrice de Conformité aux Exigences

| N° | Exigence du Sujet | Implémentation technique | Statut |
| :---: | :--- | :--- | :---: |
| **C1** | **Limite stricte de téléchargements** (Jamais $> \text{maxDownloads}$) | `TransactWriteItems` conditionnel avec décrément atomique (`downloadCount < maxDownloads`). Preuve formelle fournie dans `test.md`. | ✅ **CONFORME** |
| **C2** | **Zéro perte de données en collaboration** (CRDT Yjs) | Moteur Yjs avec fusion des deltas binaires base64 réassemblés, persistance par snapshot S3 et révisions DynamoDB. | ✅ **CONFORME** |
| **C3** | **Téléchargement du document à jour à $T_1$** | Génération PDF à la volée via `pdf-lib` à partir du texte accepted-revision à l'instant de la requête. | ✅ **CONFORME** |
| **C4** | **Quota de 10 000 caractères / jour partagé** | Calcul en points de code Unicode sur les insertions nettes, mis à jour de façon atomique sur `QUOTA#<userId>#<date>`. | ✅ **CONFORME** |
| **C5** | **Pic de 15 000 visiteurs & 300 rédacteurs** | Réponses claires aux visiteurs (`?check=1` sans consommation, gestion de file d'attente 503/429 dans l'UI). | ✅ **CONFORME** |
| **C6** | **Notification du dernier exemplaire** | Envoi d'e-mail via Amazon SES au créateur du lien dès le dernier exemplaire + état `410 Gone` immédiat aux visiteurs. | ✅ **CONFORME** |
| **R1** | **Région unique AWS (`eu-north-1`)** | Configuration exclusive dans `infrastructure/template.yaml`. | ✅ **CONFORME** |
| **R2** | **Aucune clé AWS dans le dépôt Git** | Rôles IAM exécutés par Lambda, variable d'environnement dynamique. `.gitignore` protège `.env`. | ✅ **CONFORME** |
| **R3** | **Stockage S3 strictement privé** | Accès S3 chiffré AES256 via SDK Lambda uniquement. Pas de bucket public. | ✅ **CONFORME** |
| **R4** | **Respect de l'AWS Free Tier ($0.00)** | Architecture 100% serverless on-demand sans frais fixes. | ✅ **CONFORME** |
