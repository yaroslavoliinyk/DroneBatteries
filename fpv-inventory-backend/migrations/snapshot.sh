#!/bin/bash
# Database Snapshot Management Script
# Usage: ./snapshot.sh [create|list|restore|delete|cleanup] [args]

cd "$(dirname "$0")/.." || exit 1

COMMAND=${1:-help}
shift

case "$COMMAND" in
    create)
        echo "📸 Creating database snapshot..."
        if [ -f /.dockerenv ] || [ -n "${DOCKER_CONTAINER}" ]; then
            python migrations/003_snapshot.py create "$@"
        elif docker ps | grep -q fpv-backend; then
            docker exec -it fpv-backend python migrations/003_snapshot.py create "$@"
        else
            python migrations/003_snapshot.py create "$@"
        fi
        ;;
    list)
        echo "📋 Listing snapshots..."
        if [ -f /.dockerenv ] || [ -n "${DOCKER_CONTAINER}" ]; then
            python migrations/003_snapshot.py list
        elif docker ps | grep -q fpv-backend; then
            docker exec -it fpv-backend python migrations/003_snapshot.py list
        else
            python migrations/003_snapshot.py list
        fi
        ;;
    restore)
        echo "♻️  Restoring from snapshot..."
        if [ -f /.dockerenv ] || [ -n "${DOCKER_CONTAINER}" ]; then
            python migrations/003_snapshot.py restore "$@"
        elif docker ps | grep -q fpv-backend; then
            docker exec -it fpv-backend python migrations/003_snapshot.py restore "$@"
        else
            python migrations/003_snapshot.py restore "$@"
        fi
        ;;
    delete)
        echo "🗑️  Deleting snapshot..."
        if [ -f /.dockerenv ] || [ -n "${DOCKER_CONTAINER}" ]; then
            python migrations/003_snapshot.py delete "$@"
        elif docker ps | grep -q fpv-backend; then
            docker exec -it fpv-backend python migrations/003_snapshot.py delete "$@"
        else
            python migrations/003_snapshot.py delete "$@"
        fi
        ;;
    cleanup)
        echo "🧹 Cleaning up old snapshots..."
        if [ -f /.dockerenv ] || [ -n "${DOCKER_CONTAINER}" ]; then
            python migrations/003_snapshot.py cleanup "$@"
        elif docker ps | grep -q fpv-backend; then
            docker exec -it fpv-backend python migrations/003_snapshot.py cleanup "$@"
        else
            python migrations/003_snapshot.py cleanup "$@"
        fi
        ;;
    help|*)
        echo "========================================"
        echo "   Database Snapshot Management"
        echo "========================================"
        echo ""
        echo "Usage: ./snapshot.sh <command> [options]"
        echo ""
        echo "Commands:"
        echo "  create              Create a new snapshot"
        echo "  create -n 'name'    Create snapshot with description"
        echo "  list                List all available snapshots"
        echo "  restore <name>      Restore database from snapshot"
        echo "  delete <name>       Delete a snapshot"
        echo "  cleanup --days 30   Delete snapshots older than 30 days"
        echo ""
        echo "Examples:"
        echo "  ./snapshot.sh create"
        echo "  ./snapshot.sh create -n 'before_deploy_v2'"
        echo "  ./snapshot.sh list"
        echo "  ./snapshot.sh restore fpv_inventory_stage_snapshot_2025-11-27_14-30-00"
        echo ""
        ;;
esac

