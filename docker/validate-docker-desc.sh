#!/bin/bash
# Docker Description Validator
# Validates Docker Hub short description character count (≤100 chars)

SHORT_DESC_FILE="./docker/description/short.md"
MAX_CHARS=100

echo "======================================"
echo "Docker Description Validator"
echo "======================================"
echo ""

if [ ! -f "$SHORT_DESC_FILE" ]; then
  echo "❌ ERROR: Short description file not found: $SHORT_DESC_FILE"
  exit 1
fi

# Get character count (including newline if present)
CHAR_COUNT=$(wc -m < "$SHORT_DESC_FILE" | tr -d ' ')

# Get content
CONTENT=$(cat "$SHORT_DESC_FILE")

echo "File: $SHORT_DESC_FILE"
echo "Content:"
echo "\"$CONTENT\""
echo ""
echo "Character Count: $CHAR_COUNT / $MAX_CHARS"
echo ""

if [ "$CHAR_COUNT" -gt "$MAX_CHARS" ]; then
  echo "❌ FAILED: Description exceeds $MAX_CHARS characters"
  echo "   Please shorten by $(($CHAR_COUNT - $MAX_CHARS)) characters"
  exit 1
elif [ "$CHAR_COUNT" -eq "$MAX_CHARS" ]; then
  echo "✅ PASSED: Description is exactly $MAX_CHARS characters (at limit)"
  exit 0
else
  REMAINING=$(($MAX_CHARS - $CHAR_COUNT))
  echo "✅ PASSED: Description is within limit"
  echo "   $REMAINING characters remaining"
  exit 0
fi
