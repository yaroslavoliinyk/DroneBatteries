#!/bin/bash
# Migration script wrapper: Copy fpv_inventory to fpv_inventory_stage

cd "$(dirname "$0")/.." || exit 1

echo "Running migration: fpv_inventory → fpv_inventory_stage"
echo ""

# Check if running in Docker
if [ -f /.dockerenv ] || [ -n "${DOCKER_CONTAINER}" ]; then
    echo "Running inside Docker container..."
    python migrations/002_copy_to_stage.py
else
    # Check if we should use Docker exec
    if docker ps | grep -q fpv-backend; then
        echo "Running via Docker exec..."
        docker exec -it fpv-backend python migrations/002_copy_to_stage.py
    else
        echo "Running locally..."
        python migrations/002_copy_to_stage.py
    fi
fi

