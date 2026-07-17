const fs = require('fs');
console.log('[Loader] / contents:', fs.readdirSync('/').join(','));
try { console.log('[Loader] /loader.js exists:', fs.existsSync('/loader.js')); } catch(e) {}
try { console.log('[Loader] /mount:', fs.readdirSync('/mount').join(',')); } catch(e) {}
try { console.log('[Loader] /rootfs:', fs.readdirSync('/rootfs').join(',')); } catch(e) {}
process.exit(0);
