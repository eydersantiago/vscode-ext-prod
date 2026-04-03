//@ts-check

'use strict';

const path = require('path');

//@ts-check
/** @typedef {import('webpack').Configuration} WebpackConfig **/

/** @type WebpackConfig */
const baseConfig = {
  mode: 'none', // keep source code close to original; production mode is used in `npm run package`
  entry: './src/extension.ts',
  externals: {
    vscode: 'commonjs vscode',
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [
          {
            loader: 'ts-loader',
          },
        ],
      },
    ],
  },
  devtool: 'nosources-source-map',
  infrastructureLogging: {
    level: 'log',
  },
};

/** @type WebpackConfig */
const nodeExtensionConfig = {
  ...baseConfig,
  target: 'node',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2',
  },
};

/** @type WebpackConfig */
const webExtensionConfig = {
  ...baseConfig,
  target: 'webworker',
  output: {
    path: path.resolve(__dirname, 'dist', 'web'),
    filename: 'extension.js',
    libraryTarget: 'commonjs',
  },
};

module.exports = [nodeExtensionConfig, webExtensionConfig];
