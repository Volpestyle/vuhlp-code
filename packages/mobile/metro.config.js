const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const monorepoRoot = path.resolve(__dirname, '../..');
const vuhlpUiRoot = path.resolve(__dirname, '../../../vuhlp-ui');

const config = getDefaultConfig(__dirname);

config.watchFolders = [monorepoRoot, vuhlpUiRoot];

const resolveFromProject = (moduleName) => path.resolve(__dirname, 'node_modules', moduleName);

config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

config.resolver.extraNodeModules = {
  react: resolveFromProject('react'),
  'react-native': resolveFromProject('react-native'),
  'react-dom': resolveFromProject('react-dom'),
  'react/jsx-runtime': resolveFromProject('react/jsx-runtime'),
  'react/jsx-dev-runtime': resolveFromProject('react/jsx-dev-runtime'),
  'react-native-gesture-handler': resolveFromProject('react-native-gesture-handler'),
  three: resolveFromProject('three'),
  '@react-three/fiber': resolveFromProject('@react-three/fiber'),
  '@react-three/drei': resolveFromProject('@react-three/drei'),
};

config.resolver.unstable_enableSymlinks = true;

module.exports = config;
