import path from 'path';

const config = {
    mode: "production",
    output: {
      path: path.resolve('./dist'),
      filename: 'beeteos-js.js',
    },
    optimization: {
      minimize: true,
      minimizer: [() => ({ terserOptions: { mangle: false } })]
    },
    profile: true
};

export default config;
