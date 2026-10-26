#!/bin/bash
# Script de test rapide de l'API déployée

set -e

API_URL="https://dohwo4wdw1.execute-api.eu-north-1.amazonaws.com"
echo "🧪 Test de l'API : $API_URL"
echo ""

# Couleurs pour l'affichage
GREEN='\033[0;32m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test 1 : Health check
echo -e "${BLUE}Test 1: Health check${NC}"
HEALTH=$(curl -s $API_URL/health)
if echo "$HEALTH" | grep -q '"status":"ok"'; then
    echo -e "${GREEN}✓ Health check OK${NC}"
    echo "$HEALTH" | jq '.'
else
    echo -e "${RED}✗ Health check FAILED${NC}"
    echo "$HEALTH"
    exit 1
fi
echo ""

# Test 2 : Créer une session
echo -e "${BLUE}Test 2: Créer une session${NC}"
SESSION=$(curl -s -X POST $API_URL/sessions \
  -H "Content-Type: application/json" \
  -d '{"name":"Test User","email":"test@example.com"}')

TOKEN=$(echo "$SESSION" | jq -r '.token')
WRITER_ID=$(echo "$SESSION" | jq -r '.writer.id')

if [ -n "$TOKEN" ] && [ "$TOKEN" != "null" ]; then
    echo -e "${GREEN}✓ Session créée${NC}"
    echo "Writer ID: $WRITER_ID"
    echo "Token: ${TOKEN:0:20}..."
else
    echo -e "${RED}✗ Création de session FAILED${NC}"
    echo "$SESSION"
    exit 1
fi
echo ""

# Test 3 : Vérifier le quota
echo -e "${BLUE}Test 3: Vérifier le quota${NC}"
QUOTA=$(curl -s $API_URL/quota -H "Authorization: Bearer $TOKEN")
if echo "$QUOTA" | grep -q '"limit":10000'; then
    echo -e "${GREEN}✓ Quota récupéré${NC}"
    echo "$QUOTA" | jq '.'
else
    echo -e "${RED}✗ Quota FAILED${NC}"
    echo "$QUOTA"
    exit 1
fi
echo ""

# Test 4 : Créer un document
echo -e "${BLUE}Test 4: Créer un document${NC}"
DOC=$(curl -s -X POST $API_URL/documents \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"title":"Document de test","content":"Ceci est un test automatique"}')

DOC_ID=$(echo "$DOC" | jq -r '.document.documentId')

if [ -n "$DOC_ID" ] && [ "$DOC_ID" != "null" ]; then
    echo -e "${GREEN}✓ Document créé${NC}"
    echo "Document ID: $DOC_ID"
    USED=$(echo "$DOC" | jq -r '.quota.used')
    echo "Quota utilisé: $USED caractères"
else
    echo -e "${RED}✗ Création de document FAILED${NC}"
    echo "$DOC"
    exit 1
fi
echo ""

# Test 5 : Lister les documents
echo -e "${BLUE}Test 5: Lister les documents${NC}"
DOCS=$(curl -s $API_URL/documents -H "Authorization: Bearer $TOKEN")
COUNT=$(echo "$DOCS" | jq '.documents | length')
if [ "$COUNT" -gt 0 ]; then
    echo -e "${GREEN}✓ Documents listés: $COUNT document(s)${NC}"
    echo "$DOCS" | jq '.documents[] | {id: .documentId, title: .title}'
else
    echo -e "${RED}✗ Liste de documents FAILED${NC}"
    echo "$DOCS"
    exit 1
fi
echo ""

# Test 6 : Lire le document
echo -e "${BLUE}Test 6: Lire le document${NC}"
DOC_READ=$(curl -s $API_URL/documents/$DOC_ID -H "Authorization: Bearer $TOKEN")
CONTENT=$(echo "$DOC_READ" | jq -r '.content')
if [ "$CONTENT" = "Ceci est un test automatique" ]; then
    echo -e "${GREEN}✓ Document lu correctement${NC}"
    echo "Contenu: $CONTENT"
else
    echo -e "${RED}✗ Lecture de document FAILED${NC}"
    echo "$DOC_READ"
    exit 1
fi
echo ""

# Test 7 : Modifier le document
echo -e "${BLUE}Test 7: Modifier le document${NC}"
DOC_UPDATE=$(curl -s -X PUT $API_URL/documents/$DOC_ID \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"content":"Contenu modifié par le test"}')

VERSION=$(echo "$DOC_UPDATE" | jq -r '.version')
if [ "$VERSION" = "2" ]; then
    echo -e "${GREEN}✓ Document modifié (version $VERSION)${NC}"
else
    echo -e "${RED}✗ Modification de document FAILED${NC}"
    echo "$DOC_UPDATE"
    exit 1
fi
echo ""

# Test 8 : Créer un lien de téléchargement
echo -e "${BLUE}Test 8: Créer un lien de téléchargement PDF${NC}"
LINK=$(curl -s -X POST $API_URL/documents/$DOC_ID/download-links \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"limit":5}')

DOWNLOAD_URL=$(echo "$LINK" | jq -r '.url')
SECRET=$(echo "$LINK" | jq -r '.secret')

if [ -n "$SECRET" ] && [ "$SECRET" != "null" ]; then
    echo -e "${GREEN}✓ Lien de téléchargement créé${NC}"
    echo "URL: $DOWNLOAD_URL"
    echo "Limite: 5 téléchargements"
else
    echo -e "${RED}✗ Création de lien FAILED${NC}"
    echo "$LINK"
    exit 1
fi
echo ""

# Test 9 : Télécharger le PDF
echo -e "${BLUE}Test 9: Télécharger le PDF${NC}"
PDF_FILE="/tmp/test-doc-$DOC_ID.pdf"
HTTP_CODE=$(curl -s -o "$PDF_FILE" -w "%{http_code}" $API_URL/downloads/$SECRET)

if [ "$HTTP_CODE" = "200" ] && [ -f "$PDF_FILE" ]; then
    FILE_SIZE=$(stat -f%z "$PDF_FILE" 2>/dev/null || stat -c%s "$PDF_FILE" 2>/dev/null)
    echo -e "${GREEN}✓ PDF téléchargé${NC}"
    echo "Fichier: $PDF_FILE"
    echo "Taille: $FILE_SIZE octets"
    
    # Vérifier que c'est un vrai PDF
    if file "$PDF_FILE" | grep -q "PDF"; then
        echo -e "${GREEN}✓ Fichier PDF valide${NC}"
    else
        echo -e "${RED}✗ Fichier téléchargé n'est pas un PDF${NC}"
        exit 1
    fi
else
    echo -e "${RED}✗ Téléchargement PDF FAILED (HTTP $HTTP_CODE)${NC}"
    exit 1
fi
echo ""

# Test 10 : Vérifier le dashboard admin
echo -e "${BLUE}Test 10: Dashboard admin${NC}"
ADMIN_SECRET="${ADMIN_SECRET:-changeme}"
STATS=$(curl -s $API_URL/admin/stats -H "Authorization: Bearer $ADMIN_SECRET")

DOC_COUNT=$(echo "$STATS" | jq '.openDocuments | length')
LINK_COUNT=$(echo "$STATS" | jq '.activeLinks | length')

if [ "$DOC_COUNT" -gt 0 ] && [ "$LINK_COUNT" -gt 0 ]; then
    echo -e "${GREEN}✓ Dashboard admin accessible${NC}"
    echo "Documents ouverts: $DOC_COUNT"
    echo "Liens actifs: $LINK_COUNT"
    echo "Utilisateurs bloqués: $(echo "$STATS" | jq '.blockedWriters | length')"
    echo "Connexions actives: $(echo "$STATS" | jq '.activeConnections | length')"
else
    echo -e "${RED}✗ Dashboard admin FAILED${NC}"
    echo "$STATS"
    exit 1
fi
echo ""

# Résumé
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✓ Tous les tests ont réussi !${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "📊 Résumé:"
echo "  • API URL: $API_URL"
echo "  • Document créé: $DOC_ID"
echo "  • Lien de téléchargement: $DOWNLOAD_URL"
echo "  • PDF téléchargé: $PDF_FILE"
echo ""
echo "🌐 Tester le frontend:"
echo "  cd frontend/ && npm run dev"
echo "  Ouvrir http://localhost:5173"
echo ""
echo "🔐 Dashboard admin:"
echo "  Naviguer vers $API_URL/../admin"
echo "  Secret: $ADMIN_SECRET"
