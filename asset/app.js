(function () {
  /* ================== Config ================== */
  const CFG  = window.TDX_SNAPSHOT_CFG || {};
  const HUB  = (CFG.hub || 'https://hub.snapshot.org').replace(/\/+$/,'');
  const GQL  = HUB + '/graphql';
  const IPFS = 'https://ipfs.io/ipfs/';

  /* ================== Chains ================== */
  const CHAINS = {
    1: {
      chainId:'0x1',
      chainName:'Ethereum',
      rpcUrls:['https://rpc.ankr.com/eth'],
      nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18},
      blockExplorerUrls:['https://etherscan.io']
    },

    // BNB MAINNET (chainId 56) — keep primary for our space
    56:{
      chainId:'0x38',
      chainName:'BNB Smart Chain',
      rpcUrls:['https://bsc-dataseed.binance.org'],
      nativeCurrency:{name:'BNB',symbol:'BNB',decimals:18},
      blockExplorerUrls:['https://bscscan.com']
    },

    97:{
      chainId:'0x61',
      chainName:'BSC Testnet',
      rpcUrls:['https://data-seed-prebsc-1-s1.binance.org:8545'],
      nativeCurrency:{name:'tBNB',symbol:'tBNB',decimals:18},
      blockExplorerUrls:['https://testnet.bscscan.com']
    },
    137:{
      chainId:'0x89',
      chainName:'Polygon',
      rpcUrls:['https://polygon-rpc.com'],
      nativeCurrency:{name:'MATIC',symbol:'MATIC',decimals:18},
      blockExplorerUrls:['https://polygonscan.com']
    },
    42161:{
      chainId:'0xa4b1',
      chainName:'Arbitrum One',
      rpcUrls:['https://arb1.arbitrum.io/rpc'],
      nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18},
      blockExplorerUrls:['https://arbiscan.io']
    },
    11155111:{
      chainId:'0xaa36a7',
      chainName:'Sepolia',
      rpcUrls:['https://rpc.sepolia.org'],
      nativeCurrency:{name:'ETH',symbol:'ETH',decimals:18},
      blockExplorerUrls:['https://sepolia.etherscan.io']
    }
  };

  const NET_ALIAS = {
    '1':1,'ethereum':1,'mainnet':1,
    '56':56,'bsc':56,'bnb':56,'bsc mainnet':56,'bnb smart chain':56,
    '97':97,'bsc-testnet':97,
    '137':137,'polygon':137,'matic':137,
    '42161':42161,'arbitrum':42161,
    '11155111':11155111,'sepolia':11155111
  };

  /* ================== Utils ================== */
  const fmt   = ts => { try { return new Date(parseInt(ts,10)*1000).toLocaleString(); } catch { return ts; } };
  const short = a  => (a ? `${a.slice(0,6)}…${a.slice(-4)}` : '');
  const pretty = (err) => {
    if (!err) return 'Unknown error';
    if (typeof err === 'string') return err;
    if (err.error?.message) return err.error.message;
    if (err.data?.message)  return err.data.message;
    if (err.message)        return err.message;
    try { return JSON.stringify(err); } catch { return String(err); }
  };

  const resolveIpfs = (u='') => {
    if (!u) return '';
    if (/^ipfs:\/\//i.test(u)) return IPFS + u.replace(/^ipfs:\/\//i,'').replace(/^\/+/,'');
    return u;
  };

  /* ================== Provider selection ================== */
  function pickBestInjectedProvider() {
    const w = window;
    if (!w || !w.ethereum) return null;
    const list = Array.isArray(w.ethereum.providers) ? w.ethereum.providers : [w.ethereum];
    const score = p => p?.isMetaMask ? 100 : p?.isTrust ? 90 : p?.isBraveWallet ? 80 : 10;
    return list.sort((a,b)=>score(b)-score(a))[0] || null;
  }

  function eth() {
    const p = pickBestInjectedProvider();
    if (p && window.ethereum !== p) window.ethereum = p; // Stabilize the global provider reference
    return p || null;
  }

  const hasEth = () => !!eth();

  // NOTE: Any hard-blocking of signTypedData methods was removed; we provide safe polyfills below.

  /* ================== Wallet helpers (EIP-1193 only) ================== */
  async function accounts() {
    const p = eth(); if (!p) return [];
    try { return await p.request({method:'eth_accounts'}); } catch { return []; }
  }

  async function requestAccounts() {
    const p = eth(); if (!p) return [];
    try { return await p.request({method:'eth_requestAccounts'}); } catch { return []; }
  }

  async function pick() {
    const p = eth(); if (!p) return;
    try { await p.request({method:'wallet_requestPermissions', params:[{eth_accounts:{}}]}); } catch {}
  }

  async function addr() {
    const a = await accounts();
    return (a && a[0]) || '';
  }

  async function chainId() {
    const p = eth(); if (!p) return 0;
    try { const hex = await p.request({method:'eth_chainId'}); return parseInt(hex,16)||0; } catch { return 0; }
  }

  async function ensureChain(id) {
    const p = eth(); if (!p || !id) return true;
    const cur = await chainId();
    if (cur === id) return true;

    const info = CHAINS[id];
    try {
      await p.request({ method:'wallet_switchEthereumChain', params:[{ chainId: info.chainId }] });
      return true;
    } catch (e) {
      // If the chain is unknown to the wallet, add it first then switch
      if (String(e.code) === '4902') {
        try {
          await p.request({ method:'wallet_addEthereumChain', params:[info] });
          await p.request({ method:'wallet_switchEthereumChain', params:[{ chainId: info.chainId }] });
          return true;
        } catch (_err) {
          return false;
        }
      }
      return false;
    }
  }

  /* ================== Snapshot helpers ================== */
  function getSnapshotLib() {
    const lib = window.snapshot || window.Snapshot || (globalThis && (globalThis.snapshot || globalThis.Snapshot));
    if (!lib || !lib.Client) throw new Error('Snapshot JS not loaded.');
    return lib;
  }

  async function gql(q, vars) {
    const r = await fetch(GQL, {
      method:'POST',
      headers:{'content-type':'application/json'},
      body: JSON.stringify({ query:q, variables:vars })
    });
    const j = await r.json();
    if (j.errors) throw new Error(j.errors.map(e=>e.message).join('; '));
    return j.data;
  }

  async function fetchSpace(id) {
    const q = `query($id:String!){ space(id:$id){ id name network } }`;
    const d = await gql(q, { id });
    return d.space || null;
  }

  async function fetchActive(space, limit) {
    const q = `
      query($space:String!, $limit:Int!){
        proposals(first:$limit, where:{space_in:[$space], state:"active"}, orderBy:"created", orderDirection:desc){
          id title body state start end choices scores scores_total link author type
        }
      }`;
    const d = await gql(q, { space, limit: parseInt(limit,10)||20 });
    return (d.proposals||[]).filter(p=>p.state==='active');
  }

  /* ================== ERC20 balance (TDX) ================== */
  const TOKEN = CFG.token || {}; // { address, symbol, decimals }

  async function loadTDXBalance(address, requiredId) {
    if (!hasEth() || !TOKEN.address || !address) return null;

    const cur = await chainId();
    if (requiredId && cur !== requiredId) return null;

    try {
      const provider = new ethers.providers.Web3Provider(eth(), 'any');
      const abi = ['function balanceOf(address) view returns (uint256)'];
      const c = new ethers.Contract(TOKEN.address, abi, provider);
      const raw = await c.balanceOf(address);
      const num = ethers.utils.formatUnits(raw, TOKEN.decimals||18);
      return `${Number(num).toLocaleString(undefined,{maximumFractionDigits:2})} ${TOKEN.symbol||'TDX'}`;
    } catch {
      return null;
    }
  }

  /* ================== Render helpers ================== */
  function excerpt(md='', len=220) {
    const t = md
      .replace(/!\[[^\]]*\]\([^)]+\)/g,'')
      .replace(/\[[^\]]*\]\(([^)]+)\)/g,'$1')
      .replace(/[`*_>#\-]+/g,' ')
      .replace(/<\/?[^>]+>/g,' ')
      .replace(/\s+/g,' ').trim();
    return t.length>len ? t.slice(0,len)+'…' : t;
  }

  function firstImage(md='') {
    const m1 = md.match(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/i);
    if (m1?.[1]) return resolveIpfs(m1[1].trim());

    const m2 = md.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (m2?.[1]) return resolveIpfs(m2[1].trim());

    const m3 = md.match(/(ipfs:\/\/[^\s)'"<>]+)/i);
    if (m3?.[1]) return resolveIpfs(m3[1].trim());

    const m4 = md.match(/(https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp))/i);
    if (m4?.[1]) return m4[1].trim();

    return '';
  }

  function render(root, items, space, enableVote) {
    const list = root.querySelector('.tdx-snapshot-list');
    if (!items.length) { list.textContent = 'No active proposals.'; return; }

    list.classList.add('tdx-vertical');

    list.innerHTML = items.map(p => {
      const cover   = firstImage(p.body||'');
      const summary = excerpt(p.body||'');
      const single  = (p.type === 'single-choice' || p.type === 'basic');
      const canVote = !!(enableVote && single && (p.choices||[]).length);

      const voteBlock = canVote ? `
        <div class="tdx-vote-inline" data-inline-vote data-id="${p.id}">
          <div class="tdx-choices">
            ${p.choices.map((c,i)=>`
              <label class="tdx-choice">
                <input type="radio" name="ch-${p.id}" value="${i+1}">
                <span>${c}</span>
              </label>`).join('')}
          </div>
          <div class="tdx-inline-actions">
            <button class="tdx-btn-primary" data-submit disabled>Submit vote</button>
            <span class="tdx-meta" data-status></span>
          </div>
        </div>` : `
        <div class="tdx-inline-actions">
          <a class="tdx-btn" href="${p.link}" target="_blank" rel="noopener">Open on Snapshot</a>
        </div>`;

      return `
        <article class="tdx-card tdx-split">
          <header class="tdx-card-head">
            <span class="tdx-badge tdx-badge-active">active</span>
            <h4 class="tdx-title">${p.title}</h4>
          </header>
          <div class="tdx-card-body">
            <div class="tdx-left">
              ${summary ? `<p class="tdx-summary">${summary}</p>` : ''}
              ${cover ? `<div class="tdx-cover"><img src="${cover}" alt="cover"></div>` : ''}
              <div class="tdx-dates"><span>Start: ${fmt(p.start)}</span><span>End: ${fmt(p.end)}</span></div>
              ${!canVote ? `<a class="tdx-btn" href="${p.link}" target="_blank" rel="noopener">Open on Snapshot</a>` : ''}
            </div>
            <div class="tdx-right">${voteBlock}</div>
          </div>
        </article>`;
    }).join('');

    wireVoting(root, list, space);
  }

  /* ================== Signer polyfill (fix _signTypedData) ================== */
  function safePatchSigner() {
    try {
      const E = window.ethers;
      if (!E || !E.Signer) return;
      if (typeof E.Signer.prototype._signTypedData === 'function') return; // Already present in some ethers v5 builds

      // Lightweight polyfill: prefer EIP-712 v4, fall back to personal_sign
      E.Signer.prototype._signTypedData = async function(domain, types, value) {
        const from = (this._address && typeof this._address === 'string') ? this._address : (await this.getAddress());
        const payload = E.utils._TypedDataEncoder.getPayload(domain, types, value);
        const provider = this.provider || eth();
        if (!provider?.request) throw new Error('No provider to sign typed data');

        try {
          return await provider.request({
            method:'eth_signTypedData_v4',
            params:[from, JSON.stringify(payload)]
          });
        } catch (_e) {
          // Fallback: sign the JSON-encoded typed payload
          return await provider.request({
            method:'personal_sign',
            params:[JSON.stringify(payload), from]
          });
        }
      };
    } catch (_e) {
      /* Intentionally ignored */
    }
  }

  /* ================== Patch Snapshot.Client.sign fallback ================== */
  (function patchSnapshotClientSign() {
    try {
      const lib = window.snapshot || window.Snapshot || (globalThis && (globalThis.snapshot || globalThis.Snapshot));
      if (!lib || !lib.Client || !lib.Client.prototype) return;

      const proto = lib.Client.prototype;
      if (proto.__tdx_patched_sign) return;

      const origSign = proto.sign;
      if (typeof origSign !== 'function') return;

      proto.sign = async function (web3, address, typedData) {
        const pickProvider = () => {
          if (web3 && typeof web3.request === 'function') return web3;
          if (web3 && web3.provider && typeof web3.provider.request === 'function') return web3.provider;
          if (typeof ethereum !== 'undefined' && ethereum && typeof ethereum.request === 'function') return ethereum;
          return null;
        };

        try {
          return await origSign.call(this, web3, address, typedData);
        } catch (e) {
          const prov = pickProvider();
          if (!prov) throw e;

          const payload = JSON.stringify(typedData);
          try {
            return await prov.request({
              method: 'eth_signTypedData_v4',
              params: [address, payload]
            });
          } catch (_e1) {
            return await prov.request({
              method: 'personal_sign',
              params: [payload, address]
            });
          }
        }
      };

      proto.__tdx_patched_sign = true;
      console.log('[TDX] Snapshot.Client.sign patched: fallback to v4/personal_sign enabled');
    } catch (err) {
      console.warn('[TDX] Unable to patch Snapshot.Client.sign:', err);
    }
  })();

  /* ================== Patch ethers getSigner for _signTypedData ================== */
  (function patchGetSignerForTypedData() {
    try {
      const E = window.ethers;
      if (!E || !E.providers || !E.providers.Web3Provider) return;

      const origGetSigner = E.providers.Web3Provider.prototype.getSigner;
      if (!origGetSigner) return;

      E.providers.Web3Provider.prototype.getSigner = function(...args) {
        const s = origGetSigner.apply(this, args);

        if (typeof s._signTypedData !== 'function') {
          s._signTypedData = async (domain, types, value) => {
            const from = (s._address && typeof s._address === 'string') ? s._address : (await s.getAddress?.());
            const payload = E.utils._TypedDataEncoder.getPayload(domain, types, value);
            const prov = this.provider || (typeof ethereum !== 'undefined' ? ethereum : null);
            if (!prov?.request) throw new Error('No provider to sign typed data');

            try {
              return await prov.request({
                method:'eth_signTypedData_v4',
                params:[from, JSON.stringify(payload)]
              });
            } catch {
              return await prov.request({
                method:'personal_sign',
                params:[JSON.stringify(payload), from]
              });
            }
          };
        }

        return s;
      };
    } catch (_e) {
      /* No-op */
    }
  })();

  /* ================== Voting (Snapshot.Client) ================== */
  function wireVoting(root, list, space) {
    const requiredId = parseInt(root.dataset.requiredChain || '0',10);

    const refreshButtons = async () => {
      const a = await addr();
      list.querySelectorAll('[data-inline-vote]').forEach(b => {
        const btn = b.querySelector('[data-submit]');
        const sel = b.querySelector('input[type=radio]:checked');
        btn.textContent = a ? 'Submit vote' : 'Connect wallet to vote';
        btn.disabled = !a || !sel;
      });
    };

    list.addEventListener('refreshButtons', refreshButtons);

    list.querySelectorAll('[data-inline-vote]').forEach(box => {
      const btn  = box.querySelector('[data-submit]');
      const stat = box.querySelector('[data-status]');

      box.querySelectorAll('input[type=radio]').forEach(r => {
        r.addEventListener('change', () => {
          box.querySelectorAll('.tdx-choice').forEach(l => l.classList.remove('tdx-selected'));
          r.closest('.tdx-choice')?.classList.add('tdx-selected');
          refreshButtons();
        });
      });

      // Full replacement for the vote button click handler
      btn.addEventListener('click', async () => {
        try {
          // Apply signer patches if needed
          safePatchSigner();

          // Get address (connect if needed)
          let a = await addr();
          if (!a) { await pick(); await requestAccounts(); a = await addr(); }

          const choiceEl = box.querySelector('input[type=radio]:checked');
          if (!a) { stat.textContent = 'Please connect your wallet.'; return; }
          if (!choiceEl) { stat.textContent = 'Please select a choice.'; return; }

          // Enforce required network (if configured)
          if (requiredId) {
            const ok = await ensureChain(requiredId);
            if (!ok) {
              stat.textContent = `Network mismatch. Switch to ${CHAINS[requiredId]?.chainName || 'required network'} and try again.`;
              return;
            }
          }

          const web3 = eth();
          if (!web3) { stat.textContent = 'Wallet provider not found.'; return; }

          // Standard vote payload
          const payload = {
            space: space,
            proposal: box.dataset.id,
            choice: Number(choiceEl.value),
            reason: '',
            app: 'snapshot-v2',
            metadata: {}
          };

          // Optional per-element overrides (metadata/app) provided by the DOM
          try {
            const metaRaw = box.dataset.metadata || '';
            if (metaRaw) {
              try { payload.metadata = typeof metaRaw === 'string' ? JSON.parse(metaRaw) : metaRaw; } catch { payload.metadata = {}; }
            }
            const appFromDom = box.dataset.app;
            if (appFromDom) payload.app = appFromDom;
          } catch (_e) {
            /* Ignore DOM parsing errors */
          }

          stat.textContent = 'Submitting vote…';
          btn.disabled = true;

          const Snapshot = getSnapshotLib();
          const client = new Snapshot.Client(HUB);

          // Path 1 (preferred): let snapshot.js handle signing and sending
          try {
            await client.vote(web3, a, {
              space: payload.space,
              proposal: payload.proposal,
              type: 'single-choice',
              choice: payload.choice,
              reason: payload.reason,
              app: payload.app,
              metadata: payload.metadata
            });
            stat.textContent = 'Vote submitted ✅';
            return;
          } catch (errClient) {
            console.warn('[vote] client.vote failed, falling back to manual sign+request:', errClient);
          }

          // Path 2: manual typed-data signing (try v4, then personal_sign)
          const timestamp = Math.floor(Date.now()/1000);
          const message = {
            from: a,
            space: payload.space,
            proposal: payload.proposal,
            choice: payload.choice,
            reason: payload.reason,
            app: payload.app,
            metadata: payload.metadata,
            timestamp
          };

          // EIP-712 typed data (compatible with Snapshot expectations)
          const typedData = {
            types: {
              EIP712Domain: [{ name: 'name', type: 'string' }],
              Vote: [
                { name: 'from', type: 'address' },
                { name: 'space', type: 'string' },
                { name: 'timestamp', type: 'uint64' },
                { name: 'proposal', type: 'string' },
                { name: 'choice', type: 'uint32' },
                { name: 'reason', type: 'string' },
                { name: 'app', type: 'string' },
                { name: 'metadata', type: 'string' } // metadata as JSON string
              ]
            },
            domain: { name: 'Snapshot' },
            primaryType: 'Vote',
            message: {
              from: message.from,
              space: message.space,
              timestamp: String(message.timestamp),
              proposal: message.proposal,
              choice: Number(message.choice),
              reason: message.reason || '',
              app: message.app || '',
              metadata: JSON.stringify(message.metadata || {})
            }
          };

          // Try eth_signTypedData_v4 first
          let sig;
          try {
            sig = await web3.request({
              method: 'eth_signTypedData_v4',
              params: [a, JSON.stringify(typedData)]
            });
          } catch (eV4) {
            console.warn('[vote] eth_signTypedData_v4 failed:', eV4);

            // Fallback: personal_sign with the typed payload JSON
            try {
              const payloadForPersonal = JSON.stringify(typedData);
              sig = await web3.request({
                method: 'personal_sign',
                params: [payloadForPersonal, a]
              });
            } catch (ePers) {
              console.error('[vote] personal_sign also failed:', ePers);
              throw new Error('Signing failed (eth_signTypedData_v4 and personal_sign both failed).');
            }
          }

          // Send to Snapshot relay endpoint
          try {
            const body = {
              address: a,
              sig,
              data: {
                type: 'vote',
                payload: { ...message }
              }
            };

            const relayUrl = HUB + '/api/msg';
            const r = await fetch(relayUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body)
            });

            const jr = await r.json();
            if (!r.ok || jr.error) {
              console.error('[vote] relay response error:', jr);
              throw new Error((jr && jr.error) ? jr.error : 'Relay rejected vote');
            }

            stat.textContent = 'Vote submitted ✅';
          } catch (sendErr) {
            console.error('[vote] send error:', sendErr);
            stat.textContent = 'Error: ' + (sendErr.message || String(sendErr));
          }

        } catch (e) {
          console.group("=== Snapshot Vote Error ===");
          console.error("Full error object:", e);
          try { console.error("Stringified error:", JSON.stringify(e, null, 2)); } catch(_) {}
          console.trace();
          console.groupEnd();

          stat.textContent = 'Error: ' + (e.message || pretty(e));
        } finally {
          btn.disabled = false;
          list.dispatchEvent(new Event('refreshButtons'));
        }
      });
      // End vote handler replacement
    });

    if (hasEth()) {
      eth().removeAllListeners && eth().removeAllListeners('accountsChanged');
      eth().on && eth().on('accountsChanged', () => list.dispatchEvent(new Event('refreshButtons')));

      eth().removeAllListeners && eth().removeAllListeners('chainChanged');
      eth().on && eth().on('chainChanged', () => list.dispatchEvent(new Event('refreshButtons')));
    }

    refreshButtons();
  }

  /* ================== Boot ================== */
  document.querySelectorAll('.tdx-snapshot-wrap').forEach(async root => {
    const space = root.dataset.space || CFG.space || 'tolena.eth';
    const limit = root.dataset.limit || '9';
    const connectBtn = root.querySelector('[data-connect]');
    const walletInfo = root.querySelector('.tdx-wallet-info');

    // Resolve the required network from the Snapshot space and persist it on the root element
    let requiredId = 0, requiredName = '';
    try {
      const sp = await fetchSpace(space);
      if (sp?.network != null) {
        const n = Number(sp.network);
        requiredId = !isNaN(n) && n > 0 ? n : (NET_ALIAS[String(sp.network).toLowerCase()] || 0);
        requiredName = requiredId ? (CHAINS[requiredId]?.chainName || `Chain ${requiredId}`) : '';
      }
    } catch {}

    // Force BNB aliasing if the space/network is declared as bnb/bsc elsewhere in config
    if (!requiredId) {
      const guess = NET_ALIAS[String(CFG?.network || '').toLowerCase()] || 0;
      if (guess) { requiredId = guess; requiredName = CHAINS[guess]?.chainName || ''; }
    }

    root.dataset.requiredChain = requiredId || '';
    const hdr = root.querySelector('.tdx-snapshot-header small');
    if (hdr && requiredId) hdr.innerHTML += ` &nbsp;•&nbsp; Network: <b>${requiredName} (${requiredId})</b>`;

    async function setWalletUI(address) {
      if (address) {
        let line = `Connected: ${short(address)}`;
        const bal = await loadTDXBalance(address, requiredId);
        if (bal) line += ` • ${bal}`;
        walletInfo.textContent = line;
        walletInfo.hidden = false;
        connectBtn.textContent = 'Disconnect';
        connectBtn.dataset.mode = 'disconnect';
      } else {
        walletInfo.textContent = '';
        walletInfo.hidden = true;
        connectBtn.textContent = '🔗 Connect Wallet';
        connectBtn.dataset.mode = 'connect';
      }

      const list = root.querySelector('.tdx-snapshot-list');
      list && list.dispatchEvent(new Event('refreshButtons'));
    }

    if (connectBtn) {
      connectBtn.onclick = async () => {
        const mode = connectBtn.dataset.mode || 'connect';

        if (mode === 'disconnect') {
          await pick(); // Some wallets do not provide a true disconnect; this resets UI state only
        } else {
          if (!eth()) { alert('No EVM wallet found. Install MetaMask or Trust Wallet.'); return; }
          await pick();
          await requestAccounts();
        }

        setWalletUI(await addr());
      };
    }

    const list = root.querySelector('.tdx-snapshot-list');
    list.addEventListener('refreshButtons', async () => {
      const a = await addr();
      list.querySelectorAll('[data-inline-vote]').forEach(b => {
        const btn = b.querySelector('[data-submit]');
        const sel = b.querySelector('input[type=radio]:checked');
        btn.textContent = a ? 'Submit vote' : 'Connect wallet to vote';
        btn.disabled = !a || !sel;
      });
    });

    try {
      const items = await fetchActive(space, limit);
      render(root, items, space, true);
    } catch (e) {
      console.error(e);
      list.textContent = 'Error loading proposals.';
    }

    // Patch signer early in case other flows call typed-data signing before voting
    safePatchSigner();

    setWalletUI(await addr());
  });
})();
