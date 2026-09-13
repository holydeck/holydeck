// The harness ships no artifact: it runs the packages that do. The script exists because the root
// pipeline requires every workspace to declare all four tasks — from the root, "declares no build
// script" and "has nothing to build" look the same, and only one of them is intentional.
process.stdout.write('@holydeck/harness has nothing to build: it runs the packages that do\n');
