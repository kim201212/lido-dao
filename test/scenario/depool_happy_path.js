const {assert} = require('chai');
const {BN} = require('bn.js');
const {assertBn} = require('@aragon/contract-helpers-test/src/asserts');
const {getEventArgument} = require('@aragon/contract-helpers-test');

const {newDao, newApp} = require('../helpers/dao');
const {pad, hexConcat, toBN, ETH, tokens} = require('../helpers/utils');

const StETH = artifacts.require('StETH.sol');
const DePool = artifacts.require('TestDePool.sol');
const StakingProvidersRegistry = artifacts.require('StakingProvidersRegistry');

const OracleMock = artifacts.require('OracleMock.sol');
const ValidatorRegistrationMock = artifacts.require('ValidatorRegistrationMock.sol');


contract('DePool: happy path', ([appManager, voting, sp1, sp2, user1, user2, user3, nobody]) => {
  let oracle, validatorRegistration, pool, spRegistry, token;
  let treasuryAddr, insuranceAddr;

  it('DAO, staking providers registry, token, and pool are deployed and initialized', async () => {
    const deployed = await deployDaoAndPool(appManager, voting);

    oracle = deployed.oracle;
    validatorRegistration = deployed.validatorRegistration;
    token = deployed.token;
    pool = deployed.pool;
    spRegistry = deployed.spRegistry;
    treasuryAddr = deployed.treasuryAddr;
    insuranceAddr = deployed.insuranceAddr;
  });

  // Fee and its distribution are in basis points, 10000 corresponding to 100%

  // Total fee is 1%
  const totalFeePoints = 0.01 * 10000

  // Of this 1%, 30% goes to the treasury
  const treasuryFeePoints = 0.3 * 10000
  // 20% goes to the insurance fund
  const insuranceFeePoints = 0.2 * 10000
  // 50% goes to staking providers
  const stakingProvidersFeePoints = 0.5 * 10000

  it('voting sets fee and its distribution', async () => {
    await pool.setFee(totalFeePoints, {from: voting});

    await pool.setFeeDistribution(
      treasuryFeePoints,
      insuranceFeePoints,
      stakingProvidersFeePoints,
      {from: voting},
    );

    // Checking correctness

    assertBn(await pool.getFee({from: nobody}), totalFeePoints, 'total fee');

    const distribution = await pool.getFeeDistribution({from: nobody});
    assertBn(distribution.treasuryFeeBasisPoints, treasuryFeePoints, 'treasury fee');
    assertBn(distribution.insuranceFeeBasisPoints, insuranceFeePoints, 'insurance fee');
    assertBn(distribution.SPFeeBasisPoints, stakingProvidersFeePoints, 'staking providers fee');
  });

  const withdrawalCredentials = pad('0x0202', 32);

  it('voting sets withdrawal credentials', async () => {
    await pool.setWithdrawalCredentials(withdrawalCredentials, {from: voting});

    // Checking correctness

    assert.equal(
      await pool.getWithdrawalCredentials({from: nobody}),
      withdrawalCredentials,
      'withdrawal credentials',
    );
  });

  const stakingProvider1 = {
    name: 'SP-1',
    address: sp1,
    validators: [{
      key: pad('0x010101', 48),
      sig: pad('0x01', 96),
    }],
  };

  it('voting adds the first staking provider', async () => {
    const validatorsLimit = 1000000000;

    const spTx = await spRegistry.addStakingProvider(
      stakingProvider1.name,
      stakingProvider1.address,
      validatorsLimit,
      {from: voting},
    );

    stakingProvider1.id = getEventArgument(spTx, 'StakingProviderAdded', 'id');
    assertBn(stakingProvider1.id, 0, 'SP id');

    assertBn(await spRegistry.getStakingProvidersCount(), 1, 'total staking providers');
  });

  it('the first staking provider registers one validator (signing key)', async () => {
    const numKeys = 1;

    await spRegistry.addSigningKeys(
      stakingProvider1.id,
      numKeys,
      stakingProvider1.validators[0].key,
      stakingProvider1.validators[0].sig,
      {from: stakingProvider1.address},
    );

    // The key's been added

    const totalKeys = await spRegistry.getTotalSigningKeyCount(stakingProvider1.id, {from: nobody});
    assertBn(totalKeys, 1, 'total signing keys');

    // The key is not used yet

    const unusedKeys = await spRegistry.getUnusedSigningKeyCount(stakingProvider1.id, {from: nobody});
    assertBn(unusedKeys, 1, 'unused signing keys');
  });

  it('the first user deposits 3 ETH to the pool', async () => {
    await web3.eth.sendTransaction({to: pool.address, from: user1, value: ETH(3)});

    // No Ether was deposited yet to the validator contract

    assertBn(await validatorRegistration.totalCalls(), 0);

    const ether2Stat = await pool.getEther2Stat();
    assertBn(ether2Stat.deposited, 0, 'deposited ether2');
    assertBn(ether2Stat.remote, 0, 'remote ether2');

    // All Ether is buffered within the pool contract atm

    assertBn(await pool.getBufferedEther(), ETH(3), 'buffered ether');
    assertBn(await pool.getTotalControlledEther(), ETH(3), 'total controlled ether');

    // The amount of tokens corresponding to the deposited ETH value was minted to the user

    assertBn(await token.balanceOf(user1), tokens(3), 'user1 tokens');

    assertBn(await token.totalSupply(), tokens(3), 'token total supply');
  });

  it('the second user deposits 30 ETH to the pool', async () => {
    await web3.eth.sendTransaction({to: pool.address, from: user2, value: ETH(30)});

    // The first 32 ETH chunk was deposited to the validator registration contract,
    // using public key and signature of the only validator of the first SP

    assertBn(await validatorRegistration.totalCalls(), 1);

    const regCall = await validatorRegistration.calls.call(0);
    assert.equal(regCall.pubkey, stakingProvider1.validators[0].key);
    assert.equal(regCall.withdrawal_credentials, withdrawalCredentials);
    assert.equal(regCall.signature, stakingProvider1.validators[0].sig);
    assertBn(regCall.value, ETH(32));

    const ether2Stat = await pool.getEther2Stat();
    assertBn(ether2Stat.deposited, ETH(32), 'deposited ether2');
    assertBn(ether2Stat.remote, 0, 'remote ether2');

    // Some Ether remained buffered within the pool contract

    assertBn(await pool.getBufferedEther(), ETH(1), 'buffered ether');
    assertBn(await pool.getTotalControlledEther(), ETH(1 + 32), 'total controlled ether');

    // The amount of tokens corresponding to the deposited ETH value was minted to the users

    assertBn(await token.balanceOf(user1), tokens(3), 'user1 tokens');
    assertBn(await token.balanceOf(user2), tokens(30), 'user2 tokens');

    assertBn(await token.totalSupply(), tokens(3 + 30), 'token total supply');
  });

  it('at this point, the pool has ran out of signing keys', async () => {
    const unusedKeys = await spRegistry.getUnusedSigningKeyCount(stakingProvider1.id, {from: nobody});
    assertBn(unusedKeys, 0, 'unused signing keys');
  });

  const stakingProvider2 = {
    name: 'SP-2',
    address: sp2,
    validators: [{
      key: pad('0x020202', 48),
      sig: pad('0x02', 96),
    }],
  };

  it('voting adds the second staking provider who registers one validator', async () => {
    const validatorsLimit = 1000000000;

    const spTx = await spRegistry.addStakingProvider(
      stakingProvider2.name,
      stakingProvider2.address,
      validatorsLimit,
      {from: voting},
    );

    stakingProvider2.id = getEventArgument(spTx, 'StakingProviderAdded', 'id');
    assertBn(stakingProvider2.id, 1, 'SP id');

    assertBn(await spRegistry.getStakingProvidersCount(), 2, 'total staking providers');

    const numKeys = 1;

    await spRegistry.addSigningKeys(
      stakingProvider2.id,
      numKeys,
      stakingProvider2.validators[0].key,
      stakingProvider2.validators[0].sig,
      {from: stakingProvider2.address},
    );

    // The key's been added

    const totalKeys = await spRegistry.getTotalSigningKeyCount(stakingProvider2.id, {from: nobody});
    assertBn(totalKeys, 1, 'total signing keys');

    // The key is not used yet

    const unusedKeys = await spRegistry.getUnusedSigningKeyCount(stakingProvider2.id, {from: nobody});
    assertBn(unusedKeys, 1, 'unused signing keys');
  });

  it('the third user deposits 64 ETH to the pool', async () => {
    await web3.eth.sendTransaction({to: pool.address, from: user3, value: ETH(64)});

    // The first 32 ETH chunk was deposited to the validator registration contract,
    // using public key and signature of the only validator of the second SP

    assertBn(await validatorRegistration.totalCalls(), 2);

    const regCall = await validatorRegistration.calls.call(1);
    assert.equal(regCall.pubkey, stakingProvider2.validators[0].key);
    assert.equal(regCall.withdrawal_credentials, withdrawalCredentials);
    assert.equal(regCall.signature, stakingProvider2.validators[0].sig);
    assertBn(regCall.value, ETH(32));

    const ether2Stat = await pool.getEther2Stat();
    assertBn(ether2Stat.deposited, ETH(64), 'deposited ether2');
    assertBn(ether2Stat.remote, 0, 'remote ether2');

    // The pool has ran out of validator keys, so the remaining 32 ETH were added to the
    // pool buffer

    assertBn(await pool.getBufferedEther(), ETH(1 + 32), 'buffered ether');
    assertBn(await pool.getTotalControlledEther(), ETH(33 + 64), 'total controlled ether');

    // The amount of tokens corresponding to the deposited ETH value was minted to the users

    assertBn(await token.balanceOf(user1), tokens(3), 'user1 tokens');
    assertBn(await token.balanceOf(user2), tokens(30), 'user2 tokens');
    assertBn(await token.balanceOf(user3), tokens(64), 'user3 tokens');

    assertBn(await token.totalSupply(), tokens(3 + 30 + 64), 'token total supply');
  });

  it('the oracle reports balance increase on Ethereum2 side', async () => {
    const epoch = 100;

    // Reporting 1.5-fold balance increase (64 => 96)

    await oracle.reportEther2(epoch, ETH(96));

    // Ether2 stat reported by the pool changes correspondingly

    const ether2Stat = await pool.getEther2Stat();
    assertBn(ether2Stat.deposited, ETH(64), 'deposited ether2');
    assertBn(ether2Stat.remote, ETH(96), 'remote ether2');

    // Buffered Ether amount doesn't change

    assertBn(await pool.getBufferedEther(), ETH(33), 'buffered ether');

    // Total controlled Ether increases

    assertBn(await pool.getTotalControlledEther(), ETH(33 + 96), 'total controlled ether');

    // New tokens get minted to distribute fee, diluting token total supply:
    //
    // => mintedAmount * newPrice = totalFee
    // => newPrice = newTotalControlledEther / newTotalSupply =
    //             = newTotalControlledEther / (prevTotalSupply + mintedAmount)
    // => mintedAmount * newTotalControlledEther / (prevTotalSupply + mintedAmount) = totalFee
    // => mintedAmount = (totalFee * prevTotalSupply) / (newTotalControlledEther - totalFee)

    const reward = toBN(ETH(96 - 64));
    const prevTotalSupply = toBN(tokens(3 + 30 + 64));
    const newTotalControlledEther = toBN(ETH(33 + 96));

    const totalFee = new BN(totalFeePoints).mul(reward).divn(10000);
    const mintedAmount = totalFee.mul(prevTotalSupply).div(newTotalControlledEther.sub(totalFee));
    const newTotalSupply = prevTotalSupply.add(mintedAmount);

    assertBn(await token.totalSupply(), newTotalSupply.toString(10), 'token total supply');

    // Token user balances don't change

    assertBn(await token.balanceOf(user1), tokens(3), 'user1 tokens');
    assertBn(await token.balanceOf(user2), tokens(30), 'user2 tokens');
    assertBn(await token.balanceOf(user3), tokens(64), 'user3 tokens');

    // Fee, in the form of minted tokens, gets distributed between treasury, insurance fund
    // and staking providers

    const treasuryTokenBalance = mintedAmount.muln(treasuryFeePoints).divn(10000);
    const insuranceTokenBalance = mintedAmount.muln(insuranceFeePoints).divn(10000);

    assertBn(await token.balanceOf(treasuryAddr), treasuryTokenBalance.toString(10),
      'treasury tokens');

    assertBn(await token.balanceOf(insuranceAddr), insuranceTokenBalance.toString(10),
      'insurance tokens');

    // Both staking providers receive the same fee since they have
    // the same effective stake (one signing key used)

    const stakingProvidersTokenBalance = mintedAmount
      .sub(treasuryTokenBalance)
      .sub(insuranceTokenBalance);

    const individualProviderBalance = stakingProvidersTokenBalance.divn(2);

    assertBn(
      await token.balanceOf(stakingProvider1.address),
      individualProviderBalance.toString(10),
      'SP-1 tokens',
    );

    assertBn(
      await token.balanceOf(stakingProvider2.address),
      individualProviderBalance.toString(10),
      'SP-2 tokens',
    );
  });
});


async function deployDaoAndPool(appManager, voting) {
  // Deploy the DAO, oracle and validator registration mocks, and base contracts for
  // StETH (the token), DePool (the pool) and StakingProvidersRegistry (the SP registry)

  const [{dao, acl}, oracle, validatorRegistration, stEthBase, poolBase, spRegistryBase] =
    await Promise.all([
      newDao(appManager),
      OracleMock.new(),
      ValidatorRegistrationMock.new(),
      StETH.new(),
      DePool.new(),
      StakingProvidersRegistry.new(),
    ]);

  // Instantiate proxies for the pool, the token, and the SP registry, using
  // the base contracts as their logic implementation

  const [tokenProxyAddress, poolProxyAddress, spRegistryProxyAddress] = await Promise.all([
    newApp(dao, 'steth', stEthBase.address, appManager),
    newApp(dao, 'depool', poolBase.address, appManager),
    newApp(dao, 'staking-providers-registry', spRegistryBase.address, appManager),
  ]);

  const [token, pool, spRegistry] = await Promise.all([
    StETH.at(tokenProxyAddress),
    DePool.at(poolProxyAddress),
    StakingProvidersRegistry.at(spRegistryProxyAddress),
  ]);

  // Initialize the token, the SP registry and the pool

  await token.initialize();
  await spRegistry.initialize();

  const [
    POOL_PAUSE_ROLE,
    POOL_MANAGE_FEE,
    POOL_MANAGE_WITHDRAWAL_KEY,
    SP_REGISTRY_SET_POOL,
    SP_REGISTRY_MANAGE_SIGNING_KEYS,
    SP_REGISTRY_ADD_STAKING_PROVIDER_ROLE,
    SP_REGISTRY_SET_STAKING_PROVIDER_ACTIVE_ROLE,
    SP_REGISTRY_SET_STAKING_PROVIDER_NAME_ROLE,
    SP_REGISTRY_SET_STAKING_PROVIDER_ADDRESS_ROLE,
    SP_REGISTRY_SET_STAKING_PROVIDER_LIMIT_ROLE,
    SP_REGISTRY_REPORT_STOPPED_VALIDATORS_ROLE,
    TOKEN_MINT_ROLE,
    TOKEN_BURN_ROLE,
  ] = await Promise.all([
    pool.PAUSE_ROLE(),
    pool.MANAGE_FEE(),
    pool.MANAGE_WITHDRAWAL_KEY(),
    spRegistry.SET_POOL(),
    spRegistry.MANAGE_SIGNING_KEYS(),
    spRegistry.ADD_STAKING_PROVIDER_ROLE(),
    spRegistry.SET_STAKING_PROVIDER_ACTIVE_ROLE(),
    spRegistry.SET_STAKING_PROVIDER_NAME_ROLE(),
    spRegistry.SET_STAKING_PROVIDER_ADDRESS_ROLE(),
    spRegistry.SET_STAKING_PROVIDER_LIMIT_ROLE(),
    spRegistry.REPORT_STOPPED_VALIDATORS_ROLE(),
    token.MINT_ROLE(),
    token.BURN_ROLE(),
  ]);

  await Promise.all([
    // Allow voting to manage the pool
    acl.createPermission(voting, pool.address, POOL_PAUSE_ROLE, appManager, {from: appManager}),
    acl.createPermission(voting, pool.address, POOL_MANAGE_FEE, appManager, {from: appManager}),
    acl.createPermission(voting, pool.address, POOL_MANAGE_WITHDRAWAL_KEY, appManager, {from: appManager}),
    // Allow voting to manage staking providers registry
    acl.createPermission(voting, spRegistry.address, SP_REGISTRY_SET_POOL, appManager, {from: appManager}),
    acl.createPermission(voting, spRegistry.address, SP_REGISTRY_MANAGE_SIGNING_KEYS, appManager, {from: appManager}),
    acl.createPermission(voting, spRegistry.address, SP_REGISTRY_ADD_STAKING_PROVIDER_ROLE, appManager, {from: appManager}),
    acl.createPermission(voting, spRegistry.address, SP_REGISTRY_SET_STAKING_PROVIDER_ACTIVE_ROLE, appManager, {from: appManager}),
    acl.createPermission(voting, spRegistry.address, SP_REGISTRY_SET_STAKING_PROVIDER_NAME_ROLE, appManager, {from: appManager}),
    acl.createPermission(voting, spRegistry.address, SP_REGISTRY_SET_STAKING_PROVIDER_ADDRESS_ROLE, appManager, {from: appManager}),
    acl.createPermission(voting, spRegistry.address, SP_REGISTRY_SET_STAKING_PROVIDER_LIMIT_ROLE, appManager, {from: appManager}),
    acl.createPermission(voting, spRegistry.address, SP_REGISTRY_REPORT_STOPPED_VALIDATORS_ROLE, appManager, {from: appManager}),
    // Allow the pool to mint and burn tokens
    acl.createPermission(pool.address, token.address, TOKEN_MINT_ROLE, appManager, {from: appManager}),
    acl.createPermission(pool.address, token.address, TOKEN_BURN_ROLE, appManager, {from: appManager}),
  ]);

  await pool.initialize(
    token.address,
    validatorRegistration.address,
    oracle.address,
    spRegistry.address,
  );

  await oracle.setPool(pool.address);
  await validatorRegistration.reset();
  await spRegistry.setPool(pool.address, {from: voting});

  const [treasuryAddr, insuranceAddr] = await Promise.all([
    pool.getTreasury(),
    pool.getInsuranceFund(),
  ]);

  return {
    dao,
    acl,
    oracle,
    validatorRegistration,
    token,
    pool,
    spRegistry,
    treasuryAddr,
    insuranceAddr,
  };
}
