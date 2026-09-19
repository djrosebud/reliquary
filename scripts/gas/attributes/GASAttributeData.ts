/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

// GAS Scripts v1

export interface GASAttributeDataInit {
  attributeName?: string;
  defaultValue?: number;
  minValue?: number;
  maxValue?: number;
  description?: string;
}

export class GASAttributeData {
  public attributeName: string;
  public defaultValue: number;
  public minValue: number;
  public maxValue: number;
  public description: string;

  constructor(init: GASAttributeDataInit = {}) {
    this.attributeName = init.attributeName ?? '';
    this.defaultValue = init.defaultValue ?? 0;
    this.minValue = init.minValue ?? Number.NEGATIVE_INFINITY;
    this.maxValue = init.maxValue ?? Number.POSITIVE_INFINITY;
    this.description = init.description ?? '';
  }
}
