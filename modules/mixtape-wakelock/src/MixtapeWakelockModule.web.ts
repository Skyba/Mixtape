import { registerWebModule, NativeModule } from 'expo';

class MixtapeWakelockModule extends NativeModule<{}> {}

export default registerWebModule(MixtapeWakelockModule, 'MixtapeWakelockModule');
