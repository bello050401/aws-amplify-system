using System.Reflection;
using PhotoStation.Desktop;
using PhotoStation.Domain;

namespace PhotoStation.Tests;

[CollectionDefinition("LightroomPreflight", DisableParallelization = true)]
public sealed class LightroomPreflightCollection { }

[Collection("LightroomPreflight")]
public sealed class LightroomPreflightTests
{
    [Fact]
    public void DisconnectedRendererDoesNotStartEditingOrChangeImportedSession()
    {
        Exception? failure = null;
        var thread = new Thread(() => {
            var root = Path.Combine(Path.GetTempPath(), "BelloPreflight", Guid.NewGuid().ToString("N"));
            var oldRoot = Environment.GetEnvironmentVariable("BELLO_PHOTO_STATION_ROOT");
            var oldNode = Environment.GetEnvironmentVariable("BELLO_PHOTO_STATION_NODE_DIR");
            try {
                Directory.CreateDirectory(root);
                Environment.SetEnvironmentVariable("BELLO_PHOTO_STATION_ROOT", root);
                Environment.SetEnvironmentVariable("BELLO_PHOTO_STATION_NODE_DIR", root);
                var vm = new MainViewModel();
                var session = new ImportSession(Guid.NewGuid(), "staging", "test", "card", "hash", DateTimeOffset.UtcNow, ImportSessionState.LocalSecured);
                vm.SelectedSession = session;
                vm.DestinationIndex=1;
                vm.DestinationFolder=root;
                vm.SaveDestinationAsync().GetAwaiter().GetResult();
                vm.EnsureLightroomReadyAsync = () => Task.FromResult(false);
                var edited = false;
                vm.SelectPresetAsync = _ => { edited = true; return Task.FromResult(true); };
                var before = Directory.GetFiles(root, "*", SearchOption.AllDirectories);
                var method = typeof(MainViewModel).GetMethod("UploadAsync", BindingFlags.Instance | BindingFlags.NonPublic)!;
                ((Task)method.Invoke(vm, null)!).GetAwaiter().GetResult();
                Assert.False(edited);
                Assert.False(vm.IsBusy);
                Assert.Equal(ImportSessionState.LocalSecured, session.State);
                Assert.Contains("保存処理は開始していません", vm.StatusText);
                Assert.Equal(before, Directory.GetFiles(root, "*", SearchOption.AllDirectories));
            } catch (Exception e) { failure = e; }
            finally {
                Environment.SetEnvironmentVariable("BELLO_PHOTO_STATION_ROOT", oldRoot);
                Environment.SetEnvironmentVariable("BELLO_PHOTO_STATION_NODE_DIR", oldNode);
                if (Directory.Exists(root)) Directory.Delete(root, true);
            }
        });
        thread.SetApartmentState(ApartmentState.STA);
        thread.Start();
        Assert.True(thread.Join(TimeSpan.FromSeconds(20)));
        if (failure is not null) throw failure;
    }
}
