import { defineConfig } from 'vite';
import webExtension from 'vite-plugin-web-extension';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';

export default defineConfig({
  plugins: [
    webExtension({
      manifest: () => {
        const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));
        const manifest = JSON.parse(readFileSync('./manifest.json', 'utf-8'));

        // Sync version from package.json
        manifest.version = pkg.version;

        return manifest;
      },
      watchFilePaths: ['src/**/*', 'icons/**/*', 'package.json', 'manifest.json'],
      browser: 'chrome',
    }),
    {
      name: 'copy-icons',
      closeBundle() {
        const iconsDir = resolve(process.cwd(), 'dist/icons');
        mkdirSync(iconsDir, { recursive: true });

        const icons = ['icon-16.png', 'icon-32.png', 'icon-48.png', 'icon-128.png'];
        icons.forEach(icon => {
          copyFileSync(
            resolve(process.cwd(), 'icons', icon),
            resolve(iconsDir, icon)
          );
        });
        console.log('Icons copied to dist/icons/');

        const guidelinesDir = resolve(process.cwd(), 'dist/src/guidelines');
        mkdirSync(guidelinesDir, { recursive: true });
        ['guidelines.html', 'guidelines.js'].forEach(f => {
          copyFileSync(
            resolve(process.cwd(), 'src/guidelines', f),
            resolve(guidelinesDir, f)
          );
        });
        console.log('Guidelines page copied to dist/src/guidelines/');
      },
    },
    {
      name: 'generate-build-info',
      closeBundle() {
        const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));
        const buildInfo = {
          version: pkg.version,
          buildTime: new Date().toISOString()
        };

        const buildInfoPath = resolve(process.cwd(), 'dist/build-info.json');
        writeFileSync(buildInfoPath, JSON.stringify(buildInfo, null, 2));
        console.log('Build info generated:', buildInfoPath);
      }
    },
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
