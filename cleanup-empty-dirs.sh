#!/bin/bash

#############################################################################
# cleanup-empty-dirs.sh
#
# Optional cleanup script to remove empty directories from Actual-sync project
# 
# This script safely removes empty directories identified during the file
# organization assessment. It verifies directories are empty before removal
# and runs tests to ensure nothing breaks.
#
# Usage: ./cleanup-empty-dirs.sh
#
# Author: AI Assistant
# Date: December 7, 2025
#############################################################################

set -e  # Exit on any error

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🧹 Actual-sync Empty Directory Cleanup${NC}"
echo "========================================"
echo ""

# Change to project root
cd "$(dirname "$0")"

# Verify we're in the right directory
if [ ! -f "package.json" ] || [ ! -d "src" ]; then
    echo -e "${RED}❌ Error: Not in Actual-sync project root${NC}"
    echo "   Please run this script from the project root directory"
    exit 1
fi

echo -e "${BLUE}Step 1: Verifying tests pass before cleanup${NC}"
echo "-------------------------------------------"
npm test > /dev/null 2>&1
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ All tests passing${NC}"
else
    echo -e "${RED}❌ Tests failing - aborting cleanup${NC}"
    echo "   Fix tests before running cleanup"
    exit 1
fi
echo ""

echo -e "${BLUE}Step 2: Checking directories${NC}"
echo "----------------------------"

CLEANUP_NEEDED=false

# Check src/utils/
if [ -d "src/utils/" ]; then
    if [ -z "$(ls -A src/utils/)" ]; then
        echo -e "${YELLOW}⚠️  src/utils/ is empty - will remove${NC}"
        CLEANUP_NEEDED=true
    else
        echo -e "${GREEN}ℹ️  src/utils/ has files - keeping${NC}"
        ls -la src/utils/
    fi
else
    echo -e "${GREEN}✅ src/utils/ already removed${NC}"
fi

# Check test-temp/
if [ -d "test-temp/" ]; then
    if [ -z "$(ls -A test-temp/)" ]; then
        echo -e "${YELLOW}⚠️  test-temp/ is empty - will remove${NC}"
        CLEANUP_NEEDED=true
    else
        echo -e "${GREEN}ℹ️  test-temp/ has files - keeping${NC}"
        ls -la test-temp/
    fi
else
    echo -e "${GREEN}✅ test-temp/ already removed${NC}"
fi

echo ""

if [ "$CLEANUP_NEEDED" = false ]; then
    echo -e "${GREEN}🎉 No cleanup needed - all directories either removed or in use${NC}"
    exit 0
fi

echo -e "${BLUE}Step 3: Removing empty directories${NC}"
echo "-----------------------------------"

# Remove src/utils/ if empty
if [ -d "src/utils/" ] && [ -z "$(ls -A src/utils/)" ]; then
    rmdir src/utils/
    echo -e "${GREEN}✅ Removed src/utils/${NC}"
fi

# Remove test-temp/ if empty
if [ -d "test-temp/" ] && [ -z "$(ls -A test-temp/)" ]; then
    rmdir test-temp/
    echo -e "${GREEN}✅ Removed test-temp/${NC}"
fi

echo ""

echo -e "${BLUE}Step 4: Verifying tests still pass${NC}"
echo "-----------------------------------"
npm test > /dev/null 2>&1
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ All tests still passing after cleanup${NC}"
else
    echo -e "${RED}❌ Tests failed after cleanup${NC}"
    echo "   This should not happen (empty directories don't affect tests)"
    echo "   Please investigate and report this issue"
    exit 1
fi
echo ""

echo -e "${BLUE}Step 5: Final structure verification${NC}"
echo "-------------------------------------"
echo ""
echo "Current structure:"
tree -L 2 -I 'node_modules|coverage|.git' || ls -la
echo ""

echo -e "${GREEN}🎉 Cleanup complete!${NC}"
echo ""
echo "Summary:"
echo "  • Empty directories removed"
echo "  • All tests passing"
echo "  • Project structure optimized"
echo ""
echo "Next steps:"
echo "  1. Review the changes: git status"
echo "  2. If satisfied, commit: git commit -am 'chore: remove empty directories'"
echo "  3. Continue with higher-priority tasks (see docs/REFACTORING_PLAN.md)"
