#!/bin/bash
# Load seed data into the TS-Agent database

set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Configuration
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-tsagent}"
DB_USER="${DB_USER:-admin}"
SEED_FILE="$(dirname "$0")/../seed-data.sql"

echo -e "${YELLOW}Loading seed data into TS-Agent database...${NC}"
echo "Database: $DB_NAME@$DB_HOST:$DB_PORT"
echo "User: $DB_USER"
echo "Seed file: $SEED_FILE"
echo ""

# Check if seed file exists
if [ ! -f "$SEED_FILE" ]; then
  echo -e "${RED}Error: Seed file not found at $SEED_FILE${NC}"
  exit 1
fi

# Determine if using Docker or local PostgreSQL
if command -v docker &> /dev/null && docker ps --format '{{.Names}}' | grep -q "tsagent-db"; then
  echo -e "${YELLOW}Using Docker PostgreSQL container...${NC}"
  docker exec -i tsagent-db psql -U "$DB_USER" -d "$DB_NAME" < "$SEED_FILE"
else
  echo -e "${YELLOW}Using local PostgreSQL...${NC}"
  psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" < "$SEED_FILE"
fi

if [ $? -eq 0 ]; then
  echo ""
  echo -e "${GREEN}✓ Seed data loaded successfully!${NC}"
  echo ""
  echo "Data loaded:"
  echo "  - 40 pre-defined topics across 3 categories"
  echo "  - 6 sample messages with assigned topics"
  echo ""
  echo "To verify, run:"
  echo "  SELECT COUNT(*) FROM topics;     -- Should be 40"
  echo "  SELECT COUNT(*) FROM messages;   -- Should be 6"
else
  echo -e "${RED}✗ Failed to load seed data${NC}"
  exit 1
fi
