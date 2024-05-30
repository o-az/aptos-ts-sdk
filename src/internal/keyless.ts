// Copyright © Aptos Foundation
// SPDX-License-Identifier: Apache-2.0

/**
 * This file contains the underlying implementations for exposed API surface in
 * the {@link api/keyless}. By moving the methods out into a separate file,
 * other namespaces and processes can access these methods without depending on the entire
 * keyless namespace and without having a dependency cycle error.
 */
import { AptosConfig } from "../api/aptosConfig";
import { getAptosFullNode, postAptosPepperService, postAptosProvingService } from "../client";
import {
  AccountAddress,
  EphemeralSignature,
  Groth16Zkp,
  Hex,
  KeylessConfiguration,
  ZeroKnowledgeSig,
  ZkProof,
} from "../core";
import { HexInput, LedgerVersionArg, MoveResource, ZkpVariant } from "../types";
import { EphemeralKeyPair, KeylessAccount, ProofFetchCallback } from "../account";
import {
  Groth16VerificationKeyResponse,
  KeylessConfigurationResponse,
  PepperFetchRequest,
  PepperFetchResponse,
  ProverRequest,
  ProverResponse,
} from "../types/keyless";
import { memoizeAsync } from "../utils/memoize";
import { currentTimeInSeconds } from "../utils/helpers";

/**
 * Gets the parameters of how Keyless Accounts are configured on chain including the verifying key and the max expiry horizon
 *
 * @param args.options.ledgerVersion The ledger version to query, if not provided it will get the latest version
 * @returns KeylessConfiguration
 */
async function getKeylessConfig(args: {
  aptosConfig: AptosConfig;
  options?: LedgerVersionArg;
}): Promise<KeylessConfiguration> {
  const { aptosConfig } = args;
  return memoizeAsync(
    async () => {
      const config = await getKeylessConfigurationResource(args);
      const vk = await getGroth16VerificationKeyResource(args);
      return KeylessConfiguration.create(vk, Number(config.max_exp_horizon_secs));
    },
    `keyless-configuration-${aptosConfig.network}`,
    1000 * 60 * 5, // 5 minutes
  )();
}

/**
 * Gets the KeylessConfiguration set on chain
 *
 * @param args.options.ledgerVersion The ledger version to query, if not provided it will get the latest version
 * @returns KeylessConfigurationResponse
 */
async function getKeylessConfigurationResource(args: {
  aptosConfig: AptosConfig;
  options?: LedgerVersionArg;
}): Promise<KeylessConfigurationResponse> {
  const { aptosConfig, options } = args;
  const resourceType = "0x1::keyless_account::Configuration";
  const { data } = await getAptosFullNode<{}, MoveResource<KeylessConfigurationResponse>>({
    aptosConfig,
    originMethod: "getKeylessConfigurationResource",
    path: `accounts/${AccountAddress.from("0x1").toString()}/resource/${resourceType}`,
    params: { ledger_version: options?.ledgerVersion },
  });

  return data.data;
}

/**
 * Gets the Groth16VerificationKey set on chain
 *
 * @param args.options.ledgerVersion The ledger version to query, if not provided it will get the latest version
 * @returns Groth16VerificationKeyResponse
 */
async function getGroth16VerificationKeyResource(args: {
  aptosConfig: AptosConfig;
  options?: LedgerVersionArg;
}): Promise<Groth16VerificationKeyResponse> {
  const { aptosConfig, options } = args;
  const resourceType = "0x1::keyless_account::Groth16VerificationKey";
  const { data } = await getAptosFullNode<{}, MoveResource<Groth16VerificationKeyResponse>>({
    aptosConfig,
    originMethod: "getGroth16VerificationKeyResource",
    path: `accounts/${AccountAddress.from("0x1").toString()}/resource/${resourceType}`,
    params: { ledger_version: options?.ledgerVersion },
  });

  return data.data;
}

export async function getPepper(args: {
  aptosConfig: AptosConfig;
  jwt: string;
  ephemeralKeyPair: EphemeralKeyPair;
  uidKey?: string;
  derivationPath?: string;
}): Promise<Uint8Array> {
  const { aptosConfig, jwt, ephemeralKeyPair, uidKey = "sub", derivationPath } = args;

  const body = {
    jwt_b64: jwt,
    epk: ephemeralKeyPair.getPublicKey().bcsToHex().toStringWithoutPrefix(),
    exp_date_secs: ephemeralKeyPair.expiryDateSecs,
    epk_blinder: Hex.fromHexInput(ephemeralKeyPair.blinder).toStringWithoutPrefix(),
    uid_key: uidKey,
    derivation_path: derivationPath,
  };
  const { data } = await postAptosPepperService<PepperFetchRequest, PepperFetchResponse>({
    aptosConfig,
    path: "fetch",
    body,
    originMethod: "getPepper",
    overrides: { WITH_CREDENTIALS: false },
  });
  return Hex.fromHexInput(data.pepper).toUint8Array();
}

export async function getProof(args: {
  aptosConfig: AptosConfig;
  jwt: string;
  ephemeralKeyPair: EphemeralKeyPair;
  pepper: HexInput;
  uidKey?: string;
}): Promise<ZeroKnowledgeSig> {
  const { aptosConfig, jwt, ephemeralKeyPair, pepper, uidKey = "sub" } = args;
  const { maxExpHorizonSecs } = await getKeylessConfig({ aptosConfig });
  if (maxExpHorizonSecs < ephemeralKeyPair.expiryDateSecs - currentTimeInSeconds()) {
    throw Error(`The EphemeralKeyPair is too long lived.  It's lifespan must be less than ${maxExpHorizonSecs}`);
  }
  const json = {
    jwt_b64: jwt,
    epk: ephemeralKeyPair.getPublicKey().bcsToHex().toStringWithoutPrefix(),
    epk_blinder: Hex.fromHexInput(ephemeralKeyPair.blinder).toStringWithoutPrefix(),
    exp_date_secs: ephemeralKeyPair.expiryDateSecs,
    exp_horizon_secs: maxExpHorizonSecs,
    pepper: Hex.fromHexInput(pepper).toStringWithoutPrefix(),
    uid_key: uidKey,
  };

  const { data } = await postAptosProvingService<ProverRequest, ProverResponse>({
    aptosConfig,
    path: "prove",
    body: json,
    originMethod: "getProof",
    overrides: { WITH_CREDENTIALS: false },
  });

  const proofPoints = data.proof;
  const groth16Zkp = new Groth16Zkp({
    a: proofPoints.a,
    b: proofPoints.b,
    c: proofPoints.c,
  });

  const signedProof = new ZeroKnowledgeSig({
    proof: new ZkProof(groth16Zkp, ZkpVariant.Groth16),
    trainingWheelsSignature: EphemeralSignature.fromHex(data.training_wheels_signature),
    expHorizonSecs: maxExpHorizonSecs,
  });
  return signedProof;
}

export async function deriveKeylessAccount(args: {
  aptosConfig: AptosConfig;
  jwt: string;
  ephemeralKeyPair: EphemeralKeyPair;
  uidKey?: string;
  pepper?: HexInput;
  proofFetchCallback?: ProofFetchCallback;
}): Promise<KeylessAccount> {
  const { proofFetchCallback } = args;
  let { pepper } = args;
  if (pepper === undefined) {
    pepper = await getPepper(args);
  } else {
    pepper = Hex.fromHexInput(pepper).toUint8Array();
  }

  if (pepper.length !== KeylessAccount.PEPPER_LENGTH) {
    throw new Error(`Pepper needs to be ${KeylessAccount.PEPPER_LENGTH} bytes`);
  }

  const proofPromise = getProof({ ...args, pepper });
  // If a callback is provided, pass in the proof as a promise to KeylessAccount.create.  This will make the proof be fetched in the
  // background and the callback will handle the outcome of the fetch.  This allows the developer to not have to block on the proof fetch
  // allowing for faster rendering of UX.
  //
  // If no callback is provided, the just await the proof fetch and continue syncronously.
  const proof = proofFetchCallback ? proofPromise : await proofPromise;

  const keylessAccount = KeylessAccount.create({ ...args, proof, pepper, proofFetchCallback });

  return keylessAccount;
}
