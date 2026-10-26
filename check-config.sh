#!/bin/bash
# Script de vérification de la configuration

echo "🔍 Vérification de la configuration"
echo ""

# Couleurs
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Vérifier le fichier .env
echo "1. Fichier frontend/.env"
if [ -f "frontend/.env" ]; then
    echo -e "${GREEN}✓ Fichier .env existe${NC}"
    echo "Contenu :"
    cat frontend/.env
    API_URL=$(grep VITE_API_URL frontend/.env | cut -d '=' -f2)
    if [ -n "$API_URL" ]; then
        echo -e "${GREEN}✓ VITE_API_URL défini : $API_URL${NC}"
    else
        echo -e "${RED}✗ VITE_API_URL non défini${NC}"
        exit 1
    fi
else
    echo -e "${RED}✗ Fichier .env n'existe pas${NC}"
    echo "Création du fichier..."
    echo "VITE_API_URL=https://dohwo4wdw1.execute-api.eu-north-1.amazonaws.com" > frontend/.env
    echo -e "${GREEN}✓ Fichier créé${NC}"
    API_URL="https://dohwo4wdw1.execute-api.eu-north-1.amazonaws.com"
fi
echo ""

# Tester l'API
echo "2. Test de l'API : $API_URL/health"
HEALTH_RESPONSE=$(curl -s "$API_URL/health")
if echo "$HEALTH_RESPONSE" | grep -q '"status":"ok"'; then
    echo -e "${GREEN}✓ API fonctionne${NC}"
    echo "$HEALTH_RESPONSE"
else
    echo -e "${RED}✗ API ne répond pas correctement${NC}"
    echo "$HEALTH_RESPONSE"
    exit 1
fi
echo ""

# Tester CORS
echo "3. Test CORS depuis localhost:5173"
CORS_RESPONSE=$(curl -s -X OPTIONS "$API_URL/sessions" \
    -H "Origin: http://localhost:5173" \
    -H "Access-Control-Request-Method: POST" \
    -I 2>&1 | grep -i "access-control-allow-origin")

if echo "$CORS_RESPONSE" | grep -q "localhost:5173"; then
    echo -e "${GREEN}✓ CORS configuré correctement${NC}"
    echo "$CORS_RESPONSE"
else
    echo -e "${YELLOW}⚠ CORS peut ne pas être configuré correctement${NC}"
    echo "$CORS_RESPONSE"
fi
echo ""

# Tester création de session
echo "4. Test création de session"
SESSION_RESPONSE=$(curl -s -X POST "$API_URL/sessions" \
    -H "Content-Type: application/json" \
    -d '{"name":"Test Script","email":"test@example.com"}')

if echo "$SESSION_RESPONSE" | grep -q '"token"'; then
    echo -e "${GREEN}✓ Création de session fonctionne${NC}"
    TOKEN=$(echo "$SESSION_RESPONSE" | jq -r '.token' 2>/dev/null || echo "")
    if [ -n "$TOKEN" ]; then
        echo "Token obtenu : ${TOKEN:0:30}..."
    fi
else
    echo -e "${RED}✗ Création de session échoue${NC}"
    echo "$SESSION_RESPONSE"
    exit 1
fi
echo ""

# Vérifier les processus Vite
echo "5. Processus Vite en cours"
VITE_PROCS=$(ps aux | grep -i vite | grep -v grep | wc -l)
if [ "$VITE_PROCS" -gt 0 ]; then
    echo -e "${YELLOW}⚠ $VITE_PROCS processus Vite en cours${NC}"
    echo "Il faut peut-être les arrêter et redémarrer :"
    echo "  killall node"
    echo "  cd frontend/ && npm run dev"
else
    echo -e "${GREEN}✓ Aucun processus Vite en cours${NC}"
fi
echo ""

# Résumé
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✓ Configuration vérifiée${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "📋 Pour lancer le frontend :"
echo "  cd frontend/"
echo "  npm run dev"
echo ""
echo "🌐 Ouvrir dans le navigateur :"
echo "  http://localhost:5173"
echo ""
echo "🔍 En cas d'erreur 'Failed to fetch' :"
echo "  1. Ouvrir la console développeur (F12)"
echo "  2. Aller dans l'onglet Network"
echo "  3. Voir les détails de la requête"
echo "  4. Vérifier les headers CORS"
