#!/bin/bash

# Script to find all unique files modified in a given list of git commit hashes.
#
# Usage:
#   ./get_modified_files.sh <hash1> <hash2> ... <hashN>
#
# Example:
#   ./get_modified_files.sh a1b2c3d f9e8d7c 4g5h6j7

# ---

# Check if at least one commit hash is provided.
if [ "$#" -eq 0 ]; then
    echo "Error: No commit hashes provided."
    echo "Usage: $0 <hash1> <hash2> ..."
    exit 1
fi

# Create a temporary file to store the list of all files.
# Using a temp file is robust for handling a very large number of files.
TEMP_FILE=$(mktemp)

# Ensure the temporary file is cleaned up when the script exits,
# even if it exits with an error.
trap 'rm -f "$TEMP_FILE"' EXIT

echo "Processing commits..."

# Loop through each commit hash provided as an argument.
for hash in "$@"
do
    # For each hash, get the list of modified files.
    # --name-only: Shows only the names of changed files.
    # --pretty=format:"": Suppresses the commit message and other details,
    # leaving only the output from --name-only.
    git show --name-only --pretty=format:"" "$hash" >> "$TEMP_FILE"
done

# Sort the collected file names and remove duplicates to get the final unique list.
# The `sort -u` command sorts the lines and outputs only the unique ones.
sort -u "$TEMP_FILE"

echo "Done."

# The trap command at the beginning will handle removing the temporary file.
