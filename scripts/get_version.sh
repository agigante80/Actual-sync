#!/bin/bash
# Semantic Version Generator for CI/CD
# Generates semantic versions with build metadata based on Git state
#
# Format (Semantic Versioning 2.0.0):
#   - Stable release:  1.4.0
#   - Dev build:       1.4.1-dev+abcdef7
#   - Pre-release:     1.5.0-rc.1
#
# Examples by context:
#   - Main with tag:       1.0.0
#   - Main without tag:    1.0.1-dev+71f02b6
#   - Development branch:  1.0.1-dev+71f02b6
#   - Feature branch:      1.0.1-dev+71f02b6
#   - PR build:            1.0.1-dev+71f02b6

set -e

# Function to log messages (only in verbose mode)
log_info() {
    if [ "$VERBOSE" = "true" ]; then
        echo "[INFO] $1" >&2
    fi
}

log_warn() {
    if [ "$VERBOSE" = "true" ]; then
        echo "[WARN] $1" >&2
    fi
}

log_error() {
    echo "[ERROR] $1" >&2
}

# Get base version from VERSION file (preferred) or package.json (fallback)
get_base_version() {
    # First, try VERSION file
    if [ -f "VERSION" ]; then
        BASE_VERSION=$(cat VERSION | tr -d '[:space:]')
        if [ -n "$BASE_VERSION" ]; then
            log_info "Base version from VERSION file: $BASE_VERSION"
            echo "$BASE_VERSION"
            return 0
        fi
    fi
    
    # Fallback to package.json
    if [ -f "package.json" ]; then
        BASE_VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "")
        if [ -n "$BASE_VERSION" ]; then
            log_info "Base version from package.json: $BASE_VERSION"
            echo "$BASE_VERSION"
            return 0
        fi
    fi
    
    log_warn "Could not read version from VERSION or package.json, using default: 0.1.0"
    echo "0.1.0"
}

# Get current Git branch
get_branch() {
    BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
    
    if [ -z "$BRANCH" ]; then
        log_warn "Git not available or not in a Git repository, using 'unknown' branch"
        echo "unknown"
        return 1
    fi
    
    log_info "Current branch: $BRANCH"
    echo "$BRANCH"
}

# Get short commit hash
get_commit() {
    COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "")
    
    if [ -z "$COMMIT" ]; then
        log_warn "Could not get commit hash, using 'unknown'"
        echo "unknown"
        return 1
    fi
    
    log_info "Commit hash: $COMMIT"
    echo "$COMMIT"
}

# Get Git tag if on exact tag
get_tag() {
    TAG=$(git describe --exact-match --tags 2>/dev/null || echo "")
    
    if [ -n "$TAG" ]; then
        log_info "On exact tag: $TAG"
    else
        log_info "Not on an exact tag"
    fi
    
    echo "$TAG"
}

# Sanitize branch name for use in version string
sanitize_branch() {
    local branch="$1"
    # Replace special characters with hyphens
    # Keep only alphanumeric, dots, underscores, and hyphens
    local sanitized=$(echo "$branch" | sed 's/[^a-zA-Z0-9._-]/-/g')
    
    # Remove leading/trailing hyphens
    sanitized=$(echo "$sanitized" | sed 's/^-*//;s/-*$//')
    
    # Convert to lowercase
    sanitized=$(echo "$sanitized" | tr '[:upper:]' '[:lower:]')
    
    if [ "$branch" != "$sanitized" ]; then
        log_info "Sanitized branch '$branch' to '$sanitized'"
    fi
    
    echo "$sanitized"
}

# Generate semantic version string with build metadata
generate_version() {
    local base_version="$1"
    local branch="$2"
    local commit="$3"
    local tag="$4"
    
    # If on exact tag (version tag like v1.0.0), use clean version
    if [ -n "$tag" ] && [[ "$tag" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+ ]]; then
        # Strip 'v' prefix if present
        local clean_version="${tag#v}"
        log_info "Using stable release version: $clean_version"
        echo "$clean_version"
        return 0
    fi
    
    # All other builds (main, develop, feature branches) get dev pre-release + build metadata
    # Format: <version>-dev+<commit>
    # This is semver compliant: pre-release (-dev) + build metadata (+commit)
    local version="${base_version}-dev+${commit}"
    log_info "Dev build version: $version (branch: $branch)"
    echo "$version"
    return 0
}

# Main execution
main() {
    log_info "=== Dynamic Version Generator ==="
    log_info ""
    
    # Get all components
    BASE_VERSION=$(get_base_version)
    BRANCH=$(get_branch)
    COMMIT=$(get_commit)
    TAG=$(get_tag)
    
    log_info ""
    log_info "Version components:"
    log_info "  Base: $BASE_VERSION"
    log_info "  Branch: $BRANCH"
    log_info "  Commit: $COMMIT"
    log_info "  Tag: ${TAG:-none}"
    log_info ""
    
    # Generate final version
    VERSION=$(generate_version "$BASE_VERSION" "$BRANCH" "$COMMIT" "$TAG")
    
    log_info "=== Generated Version: $VERSION ==="
    
    # Output version (for CI/CD consumption)
    echo "$VERSION"
}

# Check for verbose flag
VERBOSE="false"
if [ "$1" = "--verbose" ] || [ "$1" = "-v" ]; then
    VERBOSE="true"
fi

# Run main function
main
